# `@openma/matter-feishu`

Feishu and Lark for OpenMatter, for apps each customer creates in their own
tenant (企业自建应用).

| Import                                  | Contents                                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@openma/matter-feishu/bond`            | Bond provider: tenant tokens minted from the app secret, user links by device flow or OAuth with PKCE, credential inspection, the chat catalog, the encrypted and signed webhook endpoint, event normalization |
| `@openma/matter-feishu/long-connection` | Node only. `makeFeishuLongConnectionSource`: events over the outbound WebSocket for the host-local runtime, acknowledged only after they are stored. Needs the optional peer `@larksuiteoapi/node-sdk`         |

The Bond kernel it plugs into is `@openma/matter/bond`. See
[docs/FEISHU.md](https://github.com/openma-ai/OpenMatter/blob/main/docs/FEISHU.md)
for the design and
[docs/BONDS.md](https://github.com/openma-ai/OpenMatter/blob/main/docs/BONDS.md)
for the flow, token custody, and security notes.
