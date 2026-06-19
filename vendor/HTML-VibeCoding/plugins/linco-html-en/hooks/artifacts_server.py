#!/usr/bin/env python3
"""Global artifacts preview server with hot-reload.
Usage: python3 artifacts_server.py <artifacts_dir> [port]
Serves <artifacts_dir> with a directory-index homepage + auto-reload on file change.
"""
import http.server, socketserver, os, sys, html, json, urllib.parse

ROOT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
# Plugin static assets (notebook engine css/js) live next to this script's parent.
ASSETS = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets"))

LIVE_JS = """
<script>
(function(){
  var url = location.pathname + '?__mtime=1';
  var last = null;
  setInterval(function(){
    fetch(url, {method:'HEAD', cache:'no-store'}).then(function(r){
      var m = r.headers.get('Last-Modified');
      if(last && m && m !== last){ location.reload(); }
      last = m;
    }).catch(function(){});
  }, 1000);
})();
</script>
"""

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def list_directory(self, path):
        try:
            names = sorted(os.listdir(path))
        except OSError:
            self.send_error(404, "No permission to list directory")
            return None
        items = []
        for n in names:
            if n.startswith('.'):
                continue
            full = os.path.join(path, n)
            label = n + ('/' if os.path.isdir(full) else '')
            link = urllib.parse.quote(n) + ('/' if os.path.isdir(full) else '')
            items.append('<li><a href="%s">%s</a></li>' % (link, html.escape(label)))
        body = """<!doctype html><html lang=zh><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>artifacts</title>
<style>body{{font-family:system-ui,-apple-system,sans-serif;background:#FAF9F5;color:#3D3D3A;
max-width:760px;margin:0 auto;padding:56px 32px}}h1{{font-family:Georgia,serif;font-weight:500;
color:#141413;font-size:30px}}.k{{font-family:ui-monospace,Menlo,monospace;font-size:12px;
color:#87867F;text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}}ul{{list-style:none;
padding:0;margin-top:24px}}li{{border:1.5px solid #D1CFC5;border-radius:10px;margin-bottom:8px;
background:#fff}}li a{{display:block;padding:12px 16px;text-decoration:none;color:#141413;
font-family:ui-monospace,Menlo,monospace;font-size:13.5px}}li a:hover{{color:#D97757}}
.e{{color:#87867F;font-style:italic;font-family:Georgia,serif}}</style>
{live}</head><body><div class=k>Preview · artifacts/</div>
<h1>Artifacts</h1>{list}</body></html>""".format(
            live=LIVE_JS,
            list=('<ul>' + ''.join(items) + '</ul>') if items else '<p class=e>No artifacts yet.</p>')
        enc = body.encode('utf-8')
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(enc)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command == 'GET':
            self.wfile.write(enc)
        return None

    def _serve_html(self, path):
        with open(path, 'rb') as f:
            data = f.read()
        if b'</body>' in data:
            data = data.replace(b'</body>', LIVE_JS.encode('utf-8') + b'</body>', 1)
        else:
            data += LIVE_JS.encode('utf-8')
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Last-Modified", self.date_time_string(int(os.path.getmtime(path))))
        self.end_headers()
        return data

    def do_HEAD(self):
        path = self.translate_path(self.path)
        if os.path.isfile(path) and path.endswith('.html'):
            self._serve_html(path)
            return
        return super().do_HEAD()

    def do_GET(self):
        if self.path.split('?')[0].startswith('/__assets/'):
            return self._serve_asset()
        path = self.translate_path(self.path)
        if os.path.isfile(path) and path.endswith('.html'):
            data = self._serve_html(path)
            self.wfile.write(data)
            return
        return super().do_GET()

    def _serve_asset(self):
        rel = urllib.parse.unquote(self.path.split('?')[0][len('/__assets/'):])
        target = os.path.realpath(os.path.join(ASSETS, rel))
        if os.path.commonpath([target, ASSETS]) != ASSETS or not os.path.isfile(target):
            self.send_error(404)
            return
        ctype = ('text/css; charset=utf-8' if target.endswith('.css')
                 else 'application/javascript; charset=utf-8' if target.endswith('.js')
                 else 'application/octet-stream')
        with open(target, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command == 'GET':
            self.wfile.write(data)

    def do_POST(self):
        # WYSIWYG save, confined to ROOT. Two modes:
        #  - {seed:[...]} : read the file on disk and replace ONLY the
        #    /* SEED:BEGIN */ ... /* SEED:END */ region (robust: the rest of
        #    the template, incl. scripts, is never re-serialized).
        #  - {html:"..."} : write the full document verbatim (generic fallback).
        if self.path.split('?')[0] != '/__save':
            self.send_error(404)
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(n).decode('utf-8'))
            rel = (payload.get('path') or '').lstrip('/')
            if not rel.endswith('.html'):
                raise ValueError('bad request')
            target = os.path.realpath(os.path.join(ROOT, rel))
            if os.path.commonpath([target, ROOT]) != ROOT:
                raise ValueError('path escapes root')

            if 'seed' in payload:
                if not os.path.isfile(target):
                    raise ValueError('file not found for seed-save')
                src = open(target, encoding='utf-8').read()
                seed_json = json.dumps(payload['seed'], ensure_ascii=False, indent=2)
                # Preferred (thin template): replace the <script id="seed"> JSON body.
                tag = '<script id="seed" type="application/json">'
                ti = src.find(tag)
                if ti >= 0:
                    cstart = ti + len(tag)
                    cend = src.find('</script>', cstart)
                    if cend < 0:
                        raise ValueError('seed script not closed')
                    out = src[:cstart] + '\n' + seed_json + '\n' + src[cend:]
                else:
                    # Fallback (legacy thick template): replace SEED comment region.
                    b, e = '/* SEED:BEGIN */', '/* SEED:END */'
                    i, j = src.find(b), src.find(e)
                    if i < 0 or j < 0 or j < i:
                        raise ValueError('seed marker not found')
                    out = src[:i] + b + '\nvar SEED=' + seed_json + ';\n' + src[j:]
            elif payload.get('html') is not None:
                out = payload['html']
            else:
                raise ValueError('bad request')

            with open(target, 'w', encoding='utf-8') as f:
                f.write(out)
            body = json.dumps({"ok": True, "path": rel}).encode('utf-8')
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            msg = json.dumps({"ok": False, "error": str(e)}).encode('utf-8')
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

class TCP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    with TCP(("0.0.0.0", PORT), Handler) as httpd:
        print("serving %s at http://localhost:%d/" % (ROOT, PORT))
        httpd.serve_forever()
