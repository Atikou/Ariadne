"""Private JSONL worker for local Hugging Face Transformers models.

The process is owned by Ariadne Runtime. It never downloads model files: every
from_pretrained call uses local_files_only=True and safetensors weights only.
"""

from __future__ import annotations

import json
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

_tokenizer = None
_model = None
_model_id: str | None = None
_output_lock = threading.Lock()
_active: dict[str, threading.Event] = {}


def emit(message: dict[str, Any]) -> None:
    with _output_lock:
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def unload() -> None:
    global _tokenizer, _model, _model_id
    _tokenizer = None
    _model = None
    _model_id = None
    try:
        import gc
        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def load(payload: dict[str, Any]) -> None:
    global _tokenizer, _model, _model_id
    model_id = str(payload["modelId"])
    if _model_id == model_id and _model is not None and _tokenizer is not None:
        return

    model_path = Path(str(payload["modelPath"])).resolve(strict=True)
    if not model_path.is_dir():
        raise ValueError("Safetensors 模型必须是包含 config.json 的目录")
    if not (model_path / "config.json").is_file():
        raise ValueError("模型目录缺少 config.json")
    if not any(model_path.glob("*.safetensors")):
        raise ValueError("模型目录缺少 Safetensors 权重")

    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    unload()
    device = str(payload.get("device") or "auto")
    if device == "vulkan":
        raise RuntimeError("Transformers/PyTorch 运行时不支持 Vulkan；请使用 auto、cpu 或 cuda")
    if device in ("cuda", "auto") and torch.cuda.is_available():
        device_map: Any = "auto"
    elif device == "cuda":
        raise RuntimeError("配置要求 CUDA，但当前 PyTorch 未检测到 CUDA")
    else:
        device_map = "cpu"

    _tokenizer = AutoTokenizer.from_pretrained(
        model_path,
        local_files_only=True,
        trust_remote_code=False,
    )
    _model = AutoModelForCausalLM.from_pretrained(
        model_path,
        local_files_only=True,
        trust_remote_code=False,
        use_safetensors=True,
        dtype="auto",
        device_map=device_map,
        low_cpu_mem_usage=True,
    )
    _model.eval()
    _model_id = model_id


def render_prompt(messages: list[dict[str, Any]]) -> str:
    assert _tokenizer is not None
    normalized = []
    for message in messages:
        role = str(message.get("role", "user"))
        if role == "tool":
            role = "user"
            content = f"[工具结果 {message.get('name', '')}]\n{message.get('content', '')}"
        else:
            content = str(message.get("content", ""))
        normalized.append({"role": role, "content": content})

    if getattr(_tokenizer, "chat_template", None):
        return _tokenizer.apply_chat_template(
            normalized,
            tokenize=False,
            add_generation_prompt=True,
        )
    return "\n".join(f"{item['role']}: {item['content']}" for item in normalized) + "\nassistant:"


def count_tokens(payload: dict[str, Any]) -> dict[str, Any]:
    if _tokenizer is None or _model_id is None:
        raise RuntimeError("Transformers 模型尚未加载")
    prompt = render_prompt(list(payload.get("messages") or []))
    tools = list(payload.get("tools") or [])
    if tools:
        prompt += "\ntools:" + json.dumps(tools, ensure_ascii=False, sort_keys=True)
    tokens = len(_tokenizer(prompt, add_special_tokens=True)["input_ids"])
    return {"tokens": tokens, "tokenizer": f"transformers:{_model_id}"}


def generate(request_id: str, payload: dict[str, Any], cancelled: threading.Event) -> None:
    if _model is None or _tokenizer is None:
        raise RuntimeError("Transformers 模型尚未加载")

    import torch
    from transformers import StoppingCriteria, StoppingCriteriaList, TextIteratorStreamer

    class CancellationCriteria(StoppingCriteria):
        def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
            return cancelled.is_set()

    prompt = render_prompt(list(payload.get("messages") or []))
    inputs = _tokenizer(prompt, return_tensors="pt")
    input_device = next(_model.parameters()).device
    inputs = {key: value.to(input_device) for key, value in inputs.items()}
    streamer = TextIteratorStreamer(
        _tokenizer,
        skip_prompt=True,
        skip_special_tokens=True,
    )
    kwargs: dict[str, Any] = {
        **inputs,
        "streamer": streamer,
        "max_new_tokens": int(payload.get("maxTokens") or 1024),
        "do_sample": float(payload.get("temperature") or 0) > 0,
        "pad_token_id": _tokenizer.eos_token_id,
        "stopping_criteria": StoppingCriteriaList([CancellationCriteria()]),
    }
    if kwargs["do_sample"]:
        kwargs["temperature"] = float(payload.get("temperature"))

    failure: list[BaseException] = []

    def run_generation() -> None:
        try:
            with torch.inference_mode():
                _model.generate(**kwargs)
        except BaseException as error:  # propagated after streamer closes
            failure.append(error)

    thread = threading.Thread(target=run_generation, daemon=True)
    thread.start()
    chunks: list[str] = []
    for text in streamer:
        chunks.append(text)
        emit({"id": request_id, "type": "token", "delta": text})
    thread.join()
    if cancelled.is_set():
        emit({"id": request_id, "type": "cancelled"})
        return
    if failure:
        raise failure[0]

    content = "".join(chunks)
    output_tokens = len(_tokenizer(content, add_special_tokens=False)["input_ids"])
    emit(
        {
            "id": request_id,
            "type": "result",
            "result": {
                "content": content,
                "inputTokens": int(inputs["input_ids"].shape[-1]),
                "outputTokens": output_tokens,
            },
        }
    )


def start_generate(request_id: str, payload: dict[str, Any]) -> None:
    cancelled = threading.Event()
    _active[request_id] = cancelled

    def run() -> None:
        try:
            generate(request_id, payload, cancelled)
        except BaseException as error:
            emit({"id": request_id, "type": "error", "error": "".join(traceback.format_exception(error))})
        finally:
            _active.pop(request_id, None)

    threading.Thread(target=run, daemon=True).start()


def handle(message: dict[str, Any]) -> bool:
    request_id = str(message.get("id", ""))
    command = str(message.get("command", ""))
    payload = message.get("payload") or {}
    if command == "ping":
        import safetensors  # noqa: F401
        import torch  # noqa: F401
        import transformers  # noqa: F401

        emit({"id": request_id, "type": "result", "result": {"ok": True}})
    elif command == "load":
        load(payload)
        emit({"id": request_id, "type": "result", "result": {"loadedModelId": _model_id}})
    elif command == "generate":
        start_generate(request_id, payload)
    elif command == "count_tokens":
        emit({"id": request_id, "type": "result", "result": count_tokens(payload)})
    elif command == "cancel":
        cancellation = _active.get(request_id)
        if cancellation is None:
            emit({"id": request_id, "type": "cancelled"})
        else:
            cancellation.set()
    elif command == "unload":
        unload()
        emit({"id": request_id, "type": "result"})
    elif command == "dispose":
        unload()
        emit({"id": request_id, "type": "result"})
        return False
    else:
        raise ValueError(f"未知 Transformers worker 命令：{command}")
    return True


def main() -> None:
    for raw in sys.stdin:
        try:
            message = json.loads(raw)
            if not handle(message):
                return
        except BaseException as error:
            request_id = str(locals().get("message", {}).get("id", ""))
            emit(
                {
                    "id": request_id,
                    "type": "error",
                    "error": "".join(traceback.format_exception(error)),
                }
            )


if __name__ == "__main__":
    main()
