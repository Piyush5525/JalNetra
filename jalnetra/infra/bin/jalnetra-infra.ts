#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { JalNetraInfraStack } from "../lib/jalnetra-infra-stack";

const app = new cdk.App();

new JalNetraInfraStack(app, "JalNetraInfraStack", {
  description: "JalNetra production-shaped migration infrastructure (prototype sizing)",
  env:
    process.env.CDK_DEFAULT_ACCOUNT && process.env.CDK_DEFAULT_REGION
      ? {
          account: process.env.CDK_DEFAULT_ACCOUNT,
          region: process.env.CDK_DEFAULT_REGION,
        }
      : undefined,
  terminationProtection: true,
});
