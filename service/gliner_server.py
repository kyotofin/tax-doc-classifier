import argparse
import json
import resource
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import torch
from gliner2.classification import ClassificationSchema, Classifier, compile_schema


def build_schema(tasks):
    schema = ClassificationSchema()
    for name, spec in tasks.items():
        labels = spec["labels"]
        if isinstance(labels, dict):
            labels = {k: v for k, v in labels.items()}
        schema.single(name, labels, instruction=spec.get("instruction"))
    return compile_schema(schema)


def peak_rss_mb():
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return rss / (1024 * 1024) if sys.platform == "darwin" else rss / 1024


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="fastino/gliner2.5-base-v1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--max-len", type=int, default=0)
    args = ap.parse_args()
    if args.threads > 0:
        torch.set_num_threads(args.threads)
    t0 = time.time()
    clf = Classifier.from_pretrained(args.model, map_location="cpu")
    clf.eval()
    load_s = time.time() - t0
    max_len = args.max_len or None
    stats = {"model": args.model, "load_s": load_s, "threads": torch.get_num_threads(), "calls": 0, "cpu_s": 0.0}

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
                texts = req["texts"]
                compiled = [build_schema(t) for t in req["schemas"]]
                c0 = time.process_time()
                w0 = time.perf_counter()
                scores = clf.scorer.batch_score(texts, compiled, batch_size=len(texts), max_len=max_len)
                stats["calls"] += 1
                stats["cpu_s"] += time.process_time() - c0
                out = [{k: dict(v) for k, v in s.tasks.items()} for s in scores]
                self.reply(200, {"logits": out, "wall_ms": (time.perf_counter() - w0) * 1000})
            except Exception as e:
                self.reply(500, {"error": f"{type(e).__name__}: {e}"})

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(json.dumps({"ready": True, **stats}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
