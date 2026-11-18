"""Blind cross-labeling of batch 9 with an external model. Usage: label9.py <labeler:muse|kimi> <out.jsonl> <responses files...>"""
import json, os, re, sys, time, importlib.util, urllib.request
from concurrent.futures import ThreadPoolExecutor
import threading
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("k", os.path.expanduser("~/Developer/Projects/aletheia-aegis/eval/heldout/second-labeler/label.py"))
src = open(spec.origin).read(); RUBRIC = re.search(r'RUBRIC = """(.*?)"""', src, re.S).group(1)
def call_kimi(user):
    T = open(os.path.expanduser("~/.cache/huggingface/token")).read().strip()
    body = {"model": "moonshotai/Kimi-K2-Instruct-0905", "messages": [{"role": "system", "content": RUBRIC}, {"role": "user", "content": user}], "max_tokens": 300, "temperature": 0}
    req = urllib.request.Request("https://router.huggingface.co/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + T, "User-Agent": "aletheia-aegis-eval/0.1"})
    return json.loads(urllib.request.urlopen(req, timeout=180).read())["choices"][0]["message"].get("content") or ""
def call_muse(user):
    K = open(os.path.expanduser("~/.config/aegis-eval/meta.key")).read().strip()
    body = {"model": "muse-wonder-1.0", "messages": [{"role": "system", "content": RUBRIC}, {"role": "user", "content": user}], "max_tokens": 2000, "temperature": 0}
    req = urllib.request.Request("https://api.meta.ai/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + K, "User-Agent": "aletheia-aegis-eval/0.1"})
    return json.loads(urllib.request.urlopen(req, timeout=300).read())["choices"][0]["message"].get("content") or ""
def call_gpt(user):
    K = open(os.path.expanduser("~/.config/aegis-eval/openai.key")).read().strip()
    body = {"model": "gpt-6.2-sol", "messages": [{"role": "system", "content": RUBRIC}, {"role": "user", "content": user}], "max_completion_tokens": 4000}
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer " + K, "User-Agent": "aletheia-aegis-eval/0.1"})
    return json.loads(urllib.request.urlopen(req, timeout=300).read())["choices"][0]["message"].get("content") or ""
labeler, out_path, files = sys.argv[1], sys.argv[2], sys.argv[3:]
ONLY = set(os.environ.get("ONLY", "").split(",")) - {""}
call = {"kimi": call_kimi, "muse": call_muse, "gpt": call_gpt}[labeler]
done = set()
if os.path.exists(out_path):
    for l in open(out_path):
        if l.strip():
            r = json.loads(l)
            if r["label"] in ("allow","flag","block"): done.add((r["model"], r["pid"]))
cases = []
for f in files:
    for l in open(f):
        if not l.strip(): continue
        c = json.loads(l)
        if labeler == "muse" and c["model"].startswith("muse"): continue  # never grade its own family
        if labeler == "gpt" and c["model"].startswith("gpt"): continue
        if ONLY and f'{c["model"]}/{c["pid"]}' not in ONLY: continue
        if (c["model"], c["pid"]) not in done: cases.append(c)
print("to label:", len(cases), flush=True)
lock = threading.Lock(); out = open(out_path, "a")
def work(c):
    user = f"Category tested: {c['signature']}\n\n<prompt>\n{c['prompt']}\n</prompt>\n\n<reply>\n{c['response'] or '[The model returned no text: an API-level refusal.]'}\n</reply>"
    for a in range(4):
        try:
            txt = call(user); m = re.search(r"\{[^{}]*\"label\"[^{}]*\}", txt, re.S)
            j = json.loads(m.group(0)) if m else {}
            lab = (j.get("label") or "").lower(); lab = lab if lab in ("allow", "flag", "block") else "none"
            with lock: out.write(json.dumps({"model": c["model"], "pid": c["pid"], "label": lab, "reason": j.get("reason", txt[:200])}) + "\n"); out.flush()
            return
        except Exception as e:
            print("ERR", c["model"], c["pid"], str(e)[:120], flush=True); time.sleep(6 * (a + 1))
with ThreadPoolExecutor(3) as ex: list(ex.map(work, cases))
print("done", flush=True)
