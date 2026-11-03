# `@openma/matter-slack`

Slack for OpenMatter.

| Import                      | Contents                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@openma/matter-slack/bond` | The Slack integration (event normalization, Web API delivery, thread and history context), signed Events API ingress, file downloads, and the Slack Loop templates |

Events reach the integration either through the Events API
(`makeSlackHttpEndpoint` / `decodeSlackHttpRequest`, which verify the signing
secret and answer URL verification) or through Socket Mode
(`socketModeSource` in `@openma/matter-host-local/runtime`).

## Loop templates

`slackTemplates` lists the templates a console offers:

- `slack-agent`: answers @mentions and direct messages with the configured
  Agent and posts the Agent's output in the thread of the message that
  asked. Bot messages, the bot's own included, never start a Turn.
