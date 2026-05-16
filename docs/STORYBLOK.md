# Storyblok Management API

If the ticket requires interacting with Storyblok (content management, story creation/update, schema changes, etc.), use the Management API.

- **API docs:** https://www.storyblok.com/docs/api/management
- **Token env var:** `STORYBLOK_OAUTH_TOKEN`
- **Token location:** `./packages/app/.env`

## Retrieve the token

```bash
STORYBLOK_TOKEN=$(grep '^STORYBLOK_OAUTH_TOKEN=' packages/app/.env | cut -d= -f2-)
```

## Make a request

Pass the token as an `Authorization` header (no `Bearer` prefix — the Management API uses a raw token):

```bash
curl -s -H "Authorization: $STORYBLOK_TOKEN" \
  "https://mapi.storyblok.com/v1/spaces/"
```

## Common patterns

```bash
# List stories in a space
curl -s -H "Authorization: $STORYBLOK_TOKEN" \
  "https://mapi.storyblok.com/v1/spaces/<space_id>/stories"

# Get a single story by slug
curl -s -H "Authorization: $STORYBLOK_TOKEN" \
  "https://mapi.storyblok.com/v1/spaces/<space_id>/stories?with_slug=<slug>"

# Update a story (POST/PUT — refer to docs)
curl -s -X PUT -H "Authorization: $STORYBLOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d @payload.json \
  "https://mapi.storyblok.com/v1/spaces/<space_id>/stories/<story_id>"
```

Storyblok rate-limits the Management API. If you're doing bulk operations, throttle to a few requests per second and back off on 429.
