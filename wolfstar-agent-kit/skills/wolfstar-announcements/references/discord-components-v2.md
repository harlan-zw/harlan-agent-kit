# Discord announcements with Components V2

Payload rules, validation, and delivery limits for a WolfStar announcement sent to Discord.

## Payload

- Top level carries `flags: 32768` and `components`. It carries no `content` and no `embeds`, because Discord rejects both next to that flag.
- The ping goes in a top-level text display (type 10) placed before the container: `New announcement for <@&ROLE_ID>:`.
- The container (type 17) sets `accent_color: 16696841`, the WolfStar gold `#FEC609`.
- Inside the container: text displays (type 10) split by separators (type 14, `divider: true`, `spacing: 1`), then one action row (type 1) holding a link button (type 2, `style: 5`, a `label`, a `url`).
- All text displays together stay under 4000 characters. When the post is longer, move the detail to the website post and link it from the button row.
- Use `#` and `##` headings and `-` bullets in text displays. Put an emoji in a section heading only.
- Match the tone of earlier WolfStar Announcements posts: short, bulleted, one italic closing line for a hint such as re-inviting the bot when slash commands do not appear.

Fixed values for the WolfStar server:

| Value                 | Use                               |
| --------------------- | --------------------------------- |
| `1240662947781414944` | the Subscribers role, as `<@&ID>` |
| `1240657458528124929` | the feedback channel, as `<#ID>`  |

## Skeleton

```json
{
  "flags": 32768,
  "components": [
    { "type": 10, "content": "New announcement for <@&SUBSCRIBERS_ROLE_ID>:" },
    {
      "type": 17,
      "accent_color": 16696841,
      "components": [
        { "type": 10, "content": "# TITLE\nOne sentence on what is live." },
        { "type": 14, "divider": true, "spacing": 1 },
        { "type": 10, "content": "## What's new\n- ..." },
        {
          "type": 1,
          "components": [
            {
              "type": 2,
              "style": 5,
              "label": "Invite",
              "url": "https://discord.com/oauth2/authorize?client_id=CLIENT_ID"
            }
          ]
        }
      ]
    }
  ]
}
```

## Validate before delivering

Parse the JSON, count the text, and run the container through `ContainerBuilder`:

```bash
mkdir -p "$TMPDIR/announce" && cd "$TMPDIR/announce" && pnpm init >/dev/null && pnpm add @discordjs/builders >/dev/null
cat > check.mjs <<'EOF'
import { readFileSync } from 'node:fs'
import { ContainerBuilder } from '@discordjs/builders'

const message = JSON.parse(readFileSync(process.argv[2], 'utf8'))
let characters = 0
;(function walk(list) {
  for (const component of list) {
    if (component.type === 10) characters += component.content.length
    if (component.components) walk(component.components)
  }
})(message.components)
new ContainerBuilder(message.components.find((component) => component.type === 17)).toJSON()
console.log(`valid, ${characters} text characters of 4000`)
EOF
node check.mjs /path/to/announcement.json
```

Report the character count in the final summary.

## Delivery

- A webhook URL needs `?with_components=true`. Without it Discord silently drops the components. A plain webhook, one not owned by an application, can use link buttons only, which is what the invite button is.
- The message.style JSON editor rejected a payload carrying a top-level `allowed_mentions` with "Failed to parse message". Leave `allowed_mentions` out. The role mention still resolves.
- When the editor still refuses, also drop `flags`. Some editors add it themselves once they see the components.
- When the editor keeps refusing, send the file straight to the webhook:

```bash
curl -X POST "https://discord.com/api/webhooks/<id>/<token>?with_components=true" \
  -H "Content-Type: application/json" \
  -d @announcement.json
```

Give the maintainer the JSON in a code block he can paste, and list every placeholder left in it: role ID, client ID or invite URL, notices channel.
