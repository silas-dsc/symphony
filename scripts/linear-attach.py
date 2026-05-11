#!/usr/bin/env python3
"""linear-attach — upload one or more files to a Linear issue as a single comment.

Usage:
  linear-attach <issue-identifier> <file-or-dir> [<file-or-dir> ...]
  linear-attach <issue-identifier> --label "Heading" <file> [<file> ...]

Arguments:
  <issue-identifier>  e.g. TEA-1234. The script resolves this to the
                      internal UUID itself, so callers do not need to.
  <file-or-dir>       One or more file paths. Directories are expanded
                      to their immediate image/video files (recursively
                      with --recursive).

Options:
  --label TEXT        Heading for the comment (default: "Screenshots").
  --recursive         Expand directories recursively.

Environment:
  LINEAR_API_KEY      Required. Personal API key with comment + file scopes.

Exit codes:
  0  success — all files uploaded, comment posted, and re-fetch confirmed
     every asset URL is present in the comment body.
  1  network or API failure during upload / post / verify.
  2  bad invocation (missing env var, no files, files don't exist).

On success the comment URL is printed to stdout. Progress and errors go
to stderr so callers can capture stdout cleanly.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import pathlib
import sys
import urllib.error
import urllib.request


LINEAR_API = "https://api.linear.app/graphql"

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v"}
ATTACHABLE_EXTS = IMAGE_EXTS | VIDEO_EXTS


def err(*args: object) -> None:
    print(*args, file=sys.stderr)


def graphql(api_key: str, query: str, variables: dict) -> dict:
    req = urllib.request.Request(
        LINEAR_API,
        data=json.dumps({"query": query, "variables": variables}).encode("utf-8"),
        headers={
            "Authorization": api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Linear API HTTP {e.code}: {body}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Linear API network error: {e.reason}") from None
    if payload.get("errors"):
        raise RuntimeError(f"Linear GraphQL error: {payload['errors']}")
    data = payload.get("data")
    if data is None:
        raise RuntimeError(f"Linear response had no data: {payload}")
    return data


def resolve_issue_uuid(api_key: str, identifier: str) -> str:
    data = graphql(
        api_key,
        "query($id: String!) { issue(id: $id) { id identifier title } }",
        {"id": identifier},
    )
    issue = data.get("issue")
    if not issue or not issue.get("id"):
        raise RuntimeError(f"Issue {identifier!r} not found in Linear")
    return issue["id"]


def upload_file(api_key: str, path: pathlib.Path) -> str:
    size = path.stat().st_size
    ctype, _ = mimetypes.guess_type(path.name)
    ctype = ctype or "application/octet-stream"

    data = graphql(
        api_key,
        (
            "mutation($ct:String!,$name:String!,$size:Int!){"
            "fileUpload(contentType:$ct,filename:$name,size:$size){"
            "success uploadFile{uploadUrl assetUrl headers{key value}}}}"
        ),
        {"ct": ctype, "name": path.name, "size": size},
    )
    fu = data.get("fileUpload") or {}
    if not fu.get("success"):
        raise RuntimeError(f"fileUpload mutation refused {path.name}: {fu}")
    uf = fu["uploadFile"]
    upload_url = uf["uploadUrl"]
    asset_url = uf["assetUrl"]
    headers = {h["key"]: h["value"] for h in (uf.get("headers") or [])}
    headers.setdefault("Content-Type", ctype)
    headers.setdefault("Cache-Control", "public, max-age=31536000")

    body = path.read_bytes()
    put_req = urllib.request.Request(upload_url, data=body, method="PUT", headers=headers)
    try:
        with urllib.request.urlopen(put_req, timeout=300) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"PUT to pre-signed URL failed for {path.name}: HTTP {e.code} {e.read()[:300]!r}"
        ) from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"PUT network error for {path.name}: {e.reason}") from None
    if status not in (200, 204):
        raise RuntimeError(f"PUT for {path.name} returned unexpected status {status}")
    return asset_url


def render_markdown(label: str, items: list[tuple[pathlib.Path, str]]) -> str:
    lines = [f"## {label}", ""]
    for path, url in items:
        ext = path.suffix.lower()
        if ext in IMAGE_EXTS:
            lines.append(f"![{path.name}]({url})")
        else:
            # Videos and other files render as download links.
            lines.append(f"[{path.name}]({url})")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def post_comment(api_key: str, issue_uuid: str, body: str) -> dict:
    data = graphql(
        api_key,
        (
            "mutation($body:String!,$issueId:String!){"
            "commentCreate(input:{body:$body,issueId:$issueId}){"
            "success comment{id url body}}}"
        ),
        {"body": body, "issueId": issue_uuid},
    )
    cc = data.get("commentCreate") or {}
    if not cc.get("success") or not cc.get("comment"):
        raise RuntimeError(f"commentCreate failed: {cc}")
    return cc["comment"]


def verify_comment(api_key: str, comment_id: str, expected_urls: list[str]) -> None:
    data = graphql(
        api_key,
        "query($id: String!) { comment(id: $id) { id body url } }",
        {"id": comment_id},
    )
    comment = data.get("comment")
    if not comment:
        raise RuntimeError(f"Comment {comment_id} not retrievable after post")
    body = comment.get("body") or ""
    missing = [u for u in expected_urls if u not in body]
    if missing:
        raise RuntimeError(
            f"Comment {comment_id} is missing {len(missing)} expected asset URL(s) — refusing to declare success"
        )


def expand_paths(inputs: list[str], recursive: bool) -> list[pathlib.Path]:
    out: list[pathlib.Path] = []
    for raw in inputs:
        p = pathlib.Path(raw)
        if p.is_file():
            out.append(p)
            continue
        if p.is_dir():
            iterator = p.rglob("*") if recursive else p.iterdir()
            for child in sorted(iterator):
                if child.is_file() and child.suffix.lower() in ATTACHABLE_EXTS:
                    out.append(child)
            continue
        raise RuntimeError(f"Not a file or directory: {p}")
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="linear-attach", description=__doc__)
    parser.add_argument("identifier", help="Linear issue identifier, e.g. TEA-1234")
    parser.add_argument("paths", nargs="+", help="File or directory paths")
    parser.add_argument("--label", default="Screenshots", help="Comment heading (default: Screenshots)")
    parser.add_argument("--recursive", action="store_true", help="Recurse into directories")
    args = parser.parse_args(argv)

    api_key = os.environ.get("LINEAR_API_KEY")
    if not api_key:
        err("error: LINEAR_API_KEY env var is not set")
        return 2

    try:
        files = expand_paths(args.paths, args.recursive)
    except RuntimeError as e:
        err(f"error: {e}")
        return 2

    if not files:
        err("error: no attachable files found (looked for: " + ", ".join(sorted(ATTACHABLE_EXTS)) + ")")
        return 2

    try:
        err(f"[linear-attach] resolving {args.identifier}…")
        issue_uuid = resolve_issue_uuid(api_key, args.identifier)
        err(f"[linear-attach] issue uuid: {issue_uuid}")

        items: list[tuple[pathlib.Path, str]] = []
        for p in files:
            err(f"[linear-attach] uploading {p} ({p.stat().st_size} bytes)…")
            url = upload_file(api_key, p)
            items.append((p, url))
            err(f"[linear-attach]   -> {url}")

        body = render_markdown(args.label, items)
        err(f"[linear-attach] posting comment with {len(items)} attachment(s)…")
        comment = post_comment(api_key, issue_uuid, body)
        err(f"[linear-attach] comment posted: {comment.get('url')}")

        verify_comment(api_key, comment["id"], [url for _, url in items])
        err(f"[linear-attach] verified — all {len(items)} asset URL(s) present in comment body")

        print(comment.get("url") or comment["id"])
        return 0
    except RuntimeError as e:
        err(f"[linear-attach] FAILED: {e}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
