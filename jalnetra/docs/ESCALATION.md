# Two-stage alert escalation (Sarpanch, then citizens)

```
Operator: Review and approve alert
        |
        v
Stage 1  IVR call to the Sarpanch  (ALERT_PHONE_NUMBER1, standard advisory, unchanged)
        |            + Telegram message with  [Escalate now]  [Reject]
        v
Sarpanch decides  (first answer wins, single use, expires after ESCALATION_TTL_MIN = 20 min)
   |-- Reject / false alarm  -> closed, nobody else is contacted
   |-- Escalate now          -> Stage 2
        v
Stage 2  IVR call to a citizen in the evacuation zone  (ALERT_PHONE_NUMBER2, different message:
         leave the area now, go to the shelter, take children and elderly, avoid the river)
```

## Where the decision can come from
| Channel | Status |
|---|---|
| Telegram buttons | Works now. The server long-polls the bot, so no public URL is needed. Only taps from `TELEGRAM_CHAT_ID` count. |
| Call response (say yes / press 1, say no / press 0) | Works without a public URL. Stage 1 now uses the two-way agent `OMNIDIM_SARPANCH_AGENT_ID` (JalNetra Sarpanch Confirmation). It reads the advisory, then asks yes/no. The server polls the provider's call log for the `decision` the agent extracts and uses it. Voice keypad digits depend on the provider's speech recognition; spoken yes/no is the dependable path. Webhook alternative: `POST /escalation/call-result` with header `x-escalation-token` (= `ESCALATION_WEBHOOK_TOKEN` or `DEMO_TOKEN`) and body `{ "metadata": { "incident_id": "demo-<alertId>" }, "response": "1" }`. It needs a public URL (tunnel) configured as the voice provider's post-call webhook, and an IVR script that asks the question. |

## Voice answers on the Sarpanch call (agent 270691)
Say it at any moment, even while the advisory is playing:
| Say | Meaning | Spoken reply |
|---|---|---|
| one / ek / yes / haan | Escalate | आपकी सूचना आगे जारी की गई है / Your alert has been escalated |
| zero / shunya / no / nahi | False alarm | इसे झूठा अलार्म दर्ज किया गया है / recorded as a false alarm |
| two / do | Heard the full message, no decision | आपका उत्तर दर्ज किया गया है / Your reply has been noted |
| repeat / dobara | Read the advisory again | |
Keypad presses are not supported by the voice provider's API (no DTMF), so use voice. Every call decision is mirrored to Telegram
(buttons removed, outcome posted) and to the site's live log.

## Safety
- Phone numbers come from the server environment only, never from a request.
- Stage 2 happens only after the Sarpanch said yes. A second tap or a late answer does nothing.
- One citizen call per escalation, 30 s cooldown between citizen calls.
- The provider allows few simultaneous calls. If stage 2 is escalated while the Sarpanch call is still running, the citizen call is retried every 10 s (up to 10 minutes) until the line is free.
- Everything is labelled as an exercise in both messages. A "dispatched" call does not mean it was answered.
- State is kept in `local-backend/data/escalations.json` (not committed).

## Messages
- Sarpanch: the existing Hindi advisory plus English (unchanged).
- Citizen: one short urgent line, Hindi then English, with the hours to arrival and the shelter (`src/live/shared.ts` `citizenAlert()`), spoken by the male-voice agent `OMNIDIM_CITIZEN_AGENT_ID`, which hangs up straight after.

## Tests
`node --test local-backend/escalation.test.mjs` (7 tests: Telegram ask, idempotency, escalate once, reject, expiry, webhook auth).
