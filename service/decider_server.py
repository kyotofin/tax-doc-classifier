import argparse
import json
import resource
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import torch
from decider.infer import Decider


def peak_rss_mb():
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Mapika/decider-2b")
    ap.add_argument("--gguf-file", default="")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()
    if args.threads > 0:
        torch.set_num_threads(args.threads)
    t0 = time.time()
    if args.gguf_file:
        opts = {"n_gpu_layers": 0, "n_ctx": 16384}
        if args.threads > 0:
            opts["n_threads"] = args.threads
        d = Decider(args.model, gguf_file=args.gguf_file, gguf_options=opts)
    else:
        d = Decider(args.model, device="cpu", dtype=torch.float32)
    load_s = time.time() - t0
    stats = {"model": args.model, "gguf": args.gguf_file or None, "load_s": load_s, "threads": args.threads or torch.get_num_threads(), "calls": 0, "cpu_s": 0.0}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            self.reply(200, {**stats, "peak_rss_mb": peak_rss_mb()})

        def do_POST(self):
            try:
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                c0 = time.process_time()
                out = d.system_one(req["state"], req["questions"])
                stats["calls"] += 1
                stats["cpu_s"] += time.process_time() - c0
                self.reply(200, out)
            except Exception as e:
                self.reply(500, {"error": f"{type(e).__name__}: {e}"})

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"ready": True, **stats}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
