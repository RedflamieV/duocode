"""DuoCode GGUF inference worker. Protocol: UTF-8 JSON lines on stdin/stdout."""
import json
import queue
import sys
import threading

from llama_cpp import Llama

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def emit(**record):
    print(json.dumps(record, ensure_ascii=False), flush=True)


def main():
    model = Llama(model_path=sys.argv[1], n_ctx=4096, verbose=False)
    requests = queue.Queue()
    cancelled = set()

    def read():
        for line in sys.stdin:
            request = json.loads(line)
            if request.get("stop"):
                cancelled.add(request["id"])
            else:
                requests.put(request)
        requests.put(None)

    threading.Thread(target=read, daemon=True).start()
    emit(ready=True)
    while (request := requests.get()) is not None:
        ident = request["id"]
        try:
            if ident not in cancelled:
                stream = model.create_chat_completion(
                    messages=request["messages"], temperature=request["temperature"],
                    max_tokens=1024, stream=True,
                )
                try:
                    for chunk in stream:
                        if ident in cancelled:
                            break
                        content = chunk["choices"][0]["delta"].get("content")
                        if content:
                            emit(id=ident, token=content)
                finally:
                    stream.close()
            emit(id=ident, done=True, stopped=ident in cancelled)
        except Exception as error:
            emit(id=ident, error=str(error))
        finally:
            cancelled.discard(ident)


if __name__ == "__main__":
    main()
