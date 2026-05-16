# Attaching files to Linear comments

Linear stores files in private cloud storage. A plain file path or `localhost` URL will never resolve. Do **not** embed files as base64 — Linear's comment body is capped at 100,000 characters and will reject even a modest PNG.

## The only working method: `fileUpload` mutation + `assetUrl`

Use the `fileUpload` mutation to obtain a pre-signed upload URL, `PUT` the file bytes to that URL, then embed the returned `assetUrl` in the comment markdown. This works for all file types.

## Get the issue UUID from a ticket identifier

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ issue(id:\"TEA-4110\") { id } }"}' | jq -r '.data.issue.id'
```

## Upload script

Use Python to avoid shell-quoting issues with large payloads. Save as `/tmp/linear_upload.py`:

```python
import json, subprocess, os

api_key      = os.environ["LINEAR_API_KEY"]
file_path    = "/tmp/screenshot.png"
issue_id     = "<LINEAR_ISSUE_UUID>"   # internal UUID, not TEA-XXXX
content_type = "image/png"             # adjust for other file types
size         = os.path.getsize(file_path)

# Step 1: request a pre-signed upload URL
query = {
    "query": "mutation($ct:String!,$name:String!,$size:Int!){fileUpload(contentType:$ct,filename:$name,size:$size){success uploadFile{uploadUrl assetUrl headers{key value}}}}",
    "variables": {"ct": content_type, "name": os.path.basename(file_path), "size": size}
}
r = subprocess.run(
    ["curl", "-s", "-X", "POST", "https://api.linear.app/graphql",
     "-H", f"Authorization: {api_key}", "-H", "Content-Type: application/json",
     "-d", json.dumps(query)],
    capture_output=True, text=True,
)
data = json.loads(r.stdout)
assert data["data"]["fileUpload"]["success"], data

uf         = data["data"]["fileUpload"]["uploadFile"]
upload_url = uf["uploadUrl"]
asset_url  = uf["assetUrl"]

# Step 2: PUT the file to the pre-signed URL
header_args = ["-H", f"Content-Type: {content_type}",
               "-H", "Cache-Control: public, max-age=31536000"]
for h in uf["headers"]:
    header_args += ["-H", f"{h['key']}: {h['value']}"]

put = subprocess.run(
    ["curl", "-s", "-w", "\n%{http_code}", "-X", "PUT", upload_url]
    + header_args + ["--data-binary", f"@{file_path}"],
    capture_output=True, text=True,
)
http_code = put.stdout.strip().split("\n")[-1]
assert http_code in ("200", "204"), f"PUT failed: {http_code}\n{put.stdout}"

# Step 3: post comment with the stable assetUrl
comment_body = f"## Screenshot\n\n![Screenshot]({asset_url})"
cq = {
    "query": "mutation($body:String!,$issueId:String!){commentCreate(input:{body:$body,issueId:$issueId}){success comment{id}}}",
    "variables": {"body": comment_body, "issueId": issue_id}
}
cr = subprocess.run(
    ["curl", "-s", "-X", "POST", "https://api.linear.app/graphql",
     "-H", f"Authorization: {api_key}", "-H", "Content-Type: application/json",
     "-d", json.dumps(cq)],
    capture_output=True, text=True,
)
print(json.loads(cr.stdout))
```

Run with: `python3 /tmp/linear_upload.py`

After posting, verify the comment rendered correctly by re-fetching the comment via GraphQL or viewing the issue in Linear.

## Batch uploads (multiple screenshots in one comment)

Loop the first two steps per file, collect the `assetUrl` values, then build one comment body that embeds all of them:

```python
body = "## Visual evidence\n\n"
for label, url in [("Mobile 375px", asset_url_1), ("Desktop", asset_url_2)]:
    body += f"### {label}\n\n![{label}]({url})\n\n"
```
