#!/usr/bin/env python3
"""Create a GitHub App from a manifest and store its credentials in the macOS Keychain.

    python3 bootstrap/github-app/create-app.py bootstrap/github-app/build-agent.manifest.json

Opens a local page that posts the manifest to GitHub. You click "Create GitHub App";
GitHub redirects back to this script with a one-time code, which it exchanges for the
App's id, private key and webhook secret. Nothing secret is written to disk or printed.

Keychain items (service "secure-agent-workflow", account "<slug>:<item>"):
    app-id, private-key (base64 of the PEM), webhook-secret

Local helper only. A fork on another OS replaces store() with its own secret store.
"""

import base64
import html
import http.server
import json
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request
import webbrowser

PORT = 8765
SERVICE = "secure-agent-workflow"
CALLBACK = f"http://localhost:{PORT}/callback"


def form_page(manifest: dict, state: str) -> bytes:
    # GitHub's manifest flow takes the manifest as a form field POSTed from the
    # user's browser, so the user is the one who confirms the App's permissions.
    value = html.escape(json.dumps(manifest), quote=True)
    action = f"https://github.com/settings/apps/new?state={state}"
    return f"""<!doctype html>
<html><body>
<p>Creating <b>{html.escape(manifest["name"])}</b>. Review the permissions on GitHub, then click Create.</p>
<form id="f" action="{action}" method="post">
  <input type="hidden" name="manifest" value="{value}">
  <button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("f").submit();</script>
</body></html>""".encode()


def wait_for_code(manifest: dict) -> str:
    state = secrets.token_urlsafe(16)
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            url = urllib.parse.urlparse(self.path)
            if url.path == "/":
                body = form_page(manifest, state)
            elif url.path == "/callback":
                query = urllib.parse.parse_qs(url.query)
                # The state check stops another page from feeding us a code for
                # an App we didn't ask for.
                if query.get("state", [""])[0] != state or "code" not in query:
                    body = b"State mismatch or missing code. Nothing was stored."
                    result["error"] = "state mismatch or missing code"
                else:
                    result["code"] = query["code"][0]
                    body = b"App created. You can close this tab."
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    webbrowser.open(f"http://localhost:{PORT}/")
    print(f"Opened http://localhost:{PORT}/ — click Create GitHub App in the browser.")
    while "code" not in result and "error" not in result:
        server.handle_request()
    server.server_close()
    if "error" in result:
        sys.exit(f"Error: {result['error']}")
    return result["code"]


def convert(code: str) -> dict:
    # The code is single-use and expires after an hour; it is the only credential
    # this call needs.
    request = urllib.request.Request(
        f"https://api.github.com/app-manifests/{code}/conversions",
        data=b"",
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def store(slug: str, item: str, value: str) -> None:
    # -U updates an existing item, so re-creating an App with the same slug
    # replaces its credentials rather than failing.
    subprocess.run(
        ["security", "add-generic-password", "-U",
         "-s", SERVICE, "-a", f"{slug}:{item}", "-w", value],
        check=True,
    )


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: create-app.py <manifest.json>")
    with open(sys.argv[1]) as f:
        manifest = json.load(f)
    manifest["redirect_url"] = CALLBACK

    app = convert(wait_for_code(manifest))
    slug = app["slug"]

    store(slug, "app-id", str(app["id"]))
    # Base64, because the Keychain returns multi-line values hex-encoded.
    store(slug, "private-key", base64.b64encode(app["pem"].encode()).decode())
    if app.get("webhook_secret"):
        store(slug, "webhook-secret", app["webhook_secret"])

    print(f"Created {slug} (id {app['id']}): {app['html_url']}")
    print(f"Stored app-id, private-key, webhook-secret in Keychain service '{SERVICE}'.")
    print(f"Install it: https://github.com/apps/{slug}/installations/new")


if __name__ == "__main__":
    main()
