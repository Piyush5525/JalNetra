import * as path from "node:path";
import * as fs from "node:fs";
import {
  CfnDeletionPolicy,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

const PLACEHOLDER_API = `
exports.handler = async (event) => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    error: "JalNetra API placeholder",
    message: "Provide a compiled aws-api Lambda handler before production deployment.",
    requestId: event?.requestContext?.requestId ?? null
  })
});
`;

const PLACEHOLDER_JOB = `
exports.handler = async (event) => {
  console.log(JSON.stringify({ message: "JalNetra scheduled job placeholder", event }));
  return { ok: true, placeholder: true };
};
`;

function retainedLogGroup(scope: Construct, id: string, name: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: name,
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN,
  });
}

function contextBoolean(scope: Construct, key: string, fallback: boolean): boolean {
  const value = scope.node.tryGetContext(key);
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function apiAssetDirectory(): string | undefined {
  const candidates = [
    process.env.JALNETRA_API_SOURCE,
    path.resolve(__dirname, "../../aws-api"),
    path.resolve(__dirname, "../../api/aws-api"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
}

function apiHandler(apiSource: string | undefined): string {
  return apiSource && fs.existsSync(path.join(apiSource, "dist", "handler.js"))
    ? "dist/handler.handler"
    : "index.handler";
}

function migrationAssetDirectory(): string {
  const source = path.resolve(__dirname, "../../aws-api");
  if (!fs.existsSync(path.join(source, "package.json")) || !fs.existsSync(path.join(source, "schema.sql"))) {
    throw new Error(`The aws-api migration asset is missing package.json or schema.sql: ${source}`);
  }
  return source;
}

export class JalNetraInfraStack extends Stack {
  public constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const enableSchedules = contextBoolean(this, "enableSchedules", false);
    const dbDeletionProtection = contextBoolean(this, "dbDeletionProtection", true);
    const dbRemovalPolicy = this.node.tryGetContext("dbRemovalPolicy") === "destroy"
      ? RemovalPolicy.DESTROY
      : RemovalPolicy.RETAIN;

    // The API/jobs need private RDS access plus outbound HTTPS to Secrets Manager and
    // the configured telephony provider, so one NAT gateway is intentional and billable.
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "private-egress",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, "LambdaSecurityGroup", {
      vpc,
      description: "JalNetra Lambda outbound and PostgreSQL access",
      allowAllOutbound: true,
    });

    const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      description: "JalNetra PostgreSQL access from resources inside the VPC",
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(5432), "PostgreSQL from JalNetra Lambdas");

    const databaseCredentials = rds.Credentials.fromGeneratedSecret("jalnetraadmin", {
      secretName: "jalnetra/prototype/database",
    });
    const database = new rds.DatabaseInstance(this, "Database", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      databaseName: "jalnetra",
      port: 5432,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      // The current account is on an RDS Free Tier plan that rejects retention
      // periods above one day. Increase this after the account plan is upgraded.
      backupRetention: Duration.days(1),
      deleteAutomatedBackups: false,
      deletionProtection: dbDeletionProtection,
      removalPolicy: dbRemovalPolicy,
      credentials: databaseCredentials,
    });
    databaseCredentials.secret?.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const databaseSecretResource = databaseCredentials.secret?.node.defaultChild as secretsmanager.CfnSecret | undefined;
    if (databaseSecretResource) {
      databaseSecretResource.cfnOptions.deletionPolicy = CfnDeletionPolicy.RETAIN;
      databaseSecretResource.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.RETAIN;
    }

    const apiSecret = new secretsmanager.Secret(this, "ApiSecret", {
      secretName: "jalnetra/prototype/api",
      description: "Placeholder for the migrated API base URL and shared integration key",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          apiBaseUrl: "https://replace-before-production.example.invalid",
          apiKey: "REPLACE_ME",
        }),
        generateStringKey: "placeholderNonce",
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const telephonySecret = new secretsmanager.Secret(this, "TelephonySecret", {
      secretName: "jalnetra/prototype/telephony",
      description: "Placeholder for OmniDimension/Twilio alert credentials",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          provider: "not_configured",
          accountId: "REPLACE_ME",
          authToken: "REPLACE_ME",
        }),
        generateStringKey: "placeholderNonce",
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const alertDlq = new sqs.Queue(this, "AlertDeadLetterQueue", {
      queueName: "jalnetra-alerts-dlq",
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });
    const alertQueue = new sqs.Queue(this, "AlertQueue", {
      queueName: "jalnetra-alerts",
      visibilityTimeout: Duration.seconds(90),
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: { queue: alertDlq, maxReceiveCount: 5 },
    });

    const apiSource = apiAssetDirectory();
    const apiFunction = new lambda.Function(this, "ApiFunction", {
      functionName: "jalnetra-api",
      description: apiSource
        ? "JalNetra API Lambda from the optional aws-api asset"
        : "JalNetra API migration placeholder; replace with aws-api before production",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: apiHandler(apiSource),
      code: apiSource ? lambda.Code.fromAsset(apiSource) : lambda.Code.fromInline(PLACEHOLDER_API),
      timeout: Duration.seconds(30),
      memorySize: 512,
      tracing: lambda.Tracing.PASS_THROUGH,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        JALNETRA_DATABASE_SECRET_ARN: database.secret?.secretArn ?? "",
        PGHOST: database.dbInstanceEndpointAddress,
        PGPORT: "5432",
        PGDATABASE: "jalnetra",
        PGUSER: "jalnetraadmin",
        PGSSL: "true",
        JALNETRA_API_SECRET_ARN: apiSecret.secretArn,
        JALNETRA_TELEPHONY_SECRET_ARN: telephonySecret.secretArn,
        JALNETRA_ALERT_QUEUE_URL: alertQueue.queueUrl,
        // Public exercise mode: /demo/* routes work without an operator key and can only call the configured demo phone,
        // under a global cap. Remove this line (or set it to anything but "true") to require operator keys again.
        JALNETRA_PUBLIC_DEMO: "true",
        // AWS helpers created outside this stack (see infra/AWS-SERVICES.md): alerts topic, follow-up workflow, route calculator, web bucket.
        JALNETRA_ALERT_TOPIC_ARN: `arn:aws:sns:${this.region}:${this.account}:jalnetra-alerts`,
        JALNETRA_WORKFLOW_ARN: `arn:aws:states:${this.region}:${this.account}:stateMachine:jalnetra-alert-followup`,
        JALNETRA_WEB_BUCKET: `jalnetra-web-prod-${this.account}`,
        JALNETRA_ROUTE_CALCULATOR: "jalnetra-routes",
      },
    });
    database.secret?.grantRead(apiFunction);
    apiSecret.grantRead(apiFunction);
    telephonySecret.grantRead(apiFunction);
    alertQueue.grantSendMessages(apiFunction);

    // This function is intentionally standalone. It is never wired to a
    // CloudFormation custom resource or deployment event; invoke it manually
    // once after deployment to initialize the empty database schema.
    const migrationFunction = new lambda.Function(this, "MigrationFunction", {
      functionName: "jalnetra-schema-migration",
      description: "One-off manual initializer for the JalNetra RDS schema",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "dist/migrate.handler",
      code: lambda.Code.fromAsset(migrationAssetDirectory()),
      timeout: Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.PASS_THROUGH,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        JALNETRA_DATABASE_SECRET_ARN: database.secret?.secretArn ?? "",
        PGHOST: database.dbInstanceEndpointAddress,
        PGPORT: "5432",
        PGDATABASE: "jalnetra",
        PGSSL: "true",
      },
    });
    database.secret?.grantRead(migrationFunction);

    const dataImportFunction = new lambda.Function(this, "DataImportFunction", {
      functionName: "jalnetra-data-import",
      description: "One-off manual import of the supplied Supabase JalNetra rows",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "dist/import-data.handler",
      code: lambda.Code.fromAsset(migrationAssetDirectory()),
      timeout: Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.PASS_THROUGH,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        JALNETRA_DATABASE_SECRET_ARN: database.secret?.secretArn ?? "",
        PGHOST: database.dbInstanceEndpointAddress,
        PGPORT: "5432",
        PGDATABASE: "jalnetra",
      },
    });
    database.secret?.grantRead(dataImportFunction);

    const jobFunction = new lambda.Function(this, "JobFunction", {
      functionName: "jalnetra-scheduled-jobs",
      description: "Placeholder worker for radar polling and three-hour re-verification",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(PLACEHOLDER_JOB),
      timeout: Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.PASS_THROUGH,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        JALNETRA_API_SECRET_ARN: apiSecret.secretArn,
        JALNETRA_ALERT_QUEUE_URL: alertQueue.queueUrl,
      },
    });
    apiSecret.grantRead(jobFunction);
    alertQueue.grantSendMessages(jobFunction);

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: "jalnetra-api",
      description: "JalNetra HTTP API placeholder preserving the migration contract",
      createDefaultStage: true,
    });
    const httpIntegration = new integrations.HttpLambdaIntegration("ApiLambdaIntegration", apiFunction);
    httpApi.addRoutes({ path: "/", methods: [apigwv2.HttpMethod.ANY], integration: httpIntegration });
    httpApi.addRoutes({ path: "/{proxy+}", methods: [apigwv2.HttpMethod.ANY], integration: httpIntegration });

    const apiLogGroup = retainedLogGroup(this, "ApiLogGroup", "/aws/lambda/jalnetra-api");
    const jobLogGroup = retainedLogGroup(this, "JobLogGroup", "/aws/lambda/jalnetra-scheduled-jobs");
    const gatewayLogGroup = retainedLogGroup(this, "GatewayLogGroup", "/aws/apigateway/jalnetra-api");
    const defaultStage = httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    defaultStage?.addPropertyOverride("AccessLogSettings", {
      DestinationArn: gatewayLogGroup.logGroupArn,
      Format: JSON.stringify({
        requestId: "$context.requestId",
        requestTime: "$context.requestTime",
        routeKey: "$context.routeKey",
        status: "$context.status",
        integrationStatus: "$context.integrationStatus",
        integrationError: "$context.integrationErrorMessage",
      }),
    });
    apiFunction.node.addDependency(apiLogGroup);
    jobFunction.node.addDependency(jobLogGroup);

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "jalnetra-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const spaClient = userPool.addClient("SpaClient", {
      userPoolClientName: "jalnetra-public-spa",
      generateSecret: false,
      preventUserExistenceErrors: true,
      authFlows: { userSrp: true, userPassword: true },
      oAuth: { flows: { authorizationCodeGrant: true }, callbackUrls: ["https://example.com"], logoutUrls: ["https://example.com"] },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Allows EventBridge Scheduler to invoke the JalNetra job placeholder",
    });
    jobFunction.grantInvoke(schedulerRole);

    const createSchedule = (id: string, name: string, expression: string, job: string) => {
      const schedule = new scheduler.CfnSchedule(this, id, {
        name,
        description: `${job} schedule; disabled until the migrated worker is ready`,
        scheduleExpression: expression,
        flexibleTimeWindow: { mode: "OFF" },
        state: enableSchedules ? "ENABLED" : "DISABLED",
        target: {
          arn: jobFunction.functionArn,
          roleArn: schedulerRole.roleArn,
          input: JSON.stringify({ job }),
          retryPolicy: { maximumEventAgeInSeconds: 3600, maximumRetryAttempts: 2 },
        },
      });
      return schedule;
    };
    const radarSchedule = createSchedule(
      "RadarSchedule",
      "jalnetra-radar-15m",
      "rate(15 minutes)",
      "radar-alerts",
    );
    const reverificationSchedule = createSchedule(
      "ReverificationSchedule",
      "jalnetra-reverify-3h",
      "rate(3 hours)",
      "reverify-incidents",
    );

    new cloudwatch.Alarm(this, "ApiLambdaErrorsAlarm", {
      alarmName: "jalnetra-api-lambda-errors",
      metric: apiFunction.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "JobLambdaErrorsAlarm", {
      alarmName: "jalnetra-job-lambda-errors",
      metric: jobFunction.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "HttpApiErrorsAlarm", {
      alarmName: "jalnetra-http-api-5xx",
      metric: new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5XXError",
        dimensionsMap: { ApiId: httpApi.httpApiId },
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "AlertQueueDepthAlarm", {
      alarmName: "jalnetra-alert-queue-visible-messages",
      metric: alertQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, "AlertDlqMessagesAlarm", {
      alarmName: "jalnetra-alert-dlq-messages",
      metric: alertDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, "VpcId", { value: vpc.vpcId });
    new CfnOutput(this, "DatabaseEndpoint", { value: database.dbInstanceEndpointAddress });
    new CfnOutput(this, "DatabaseSecretArn", { value: database.secret?.secretArn ?? "not-created" });
    new CfnOutput(this, "ApiSecretArn", { value: apiSecret.secretArn });
    new CfnOutput(this, "TelephonySecretArn", { value: telephonySecret.secretArn });
    new CfnOutput(this, "ApiUrl", { value: httpApi.url ?? "not-created" });
    new CfnOutput(this, "ApiFunctionArn", { value: apiFunction.functionArn });
    new CfnOutput(this, "MigrationFunctionArn", { value: migrationFunction.functionArn });
    new CfnOutput(this, "DataImportFunctionArn", { value: dataImportFunction.functionArn });
    new CfnOutput(this, "AlertQueueUrl", { value: alertQueue.queueUrl });
    new CfnOutput(this, "AlertQueueArn", { value: alertQueue.queueArn });
    new CfnOutput(this, "AlertDeadLetterQueueArn", { value: alertDlq.queueArn });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "SpaClientId", { value: spaClient.userPoolClientId });
    new CfnOutput(this, "RadarScheduleState", { value: enableSchedules ? "ENABLED" : "DISABLED" });
    new CfnOutput(this, "RadarScheduleName", { value: radarSchedule.name ?? "jalnetra-radar-15m" });
    new CfnOutput(this, "ReverificationScheduleName", { value: reverificationSchedule.name ?? "jalnetra-reverify-3h" });
    new CfnOutput(this, "ApiSourceMode", { value: apiSource ? `asset:${apiSource}` : "inline-placeholder" });
    new CfnOutput(this, "GatewayLogGroupName", { value: gatewayLogGroup.logGroupName });
  }
}
