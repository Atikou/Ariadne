from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import wave


PIPER_TAG = "v1.4.2"
PIPER_COMMIT = "d6975e21a440c0d8b6e5fb7c41027409af13d44d"


def main() -> None:
    parser = argparse.ArgumentParser(prog="ariadne-voice")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    dataset = sub.add_parser("dataset")
    dataset_sub = dataset.add_subparsers(dest="dataset_command", required=True)
    validate = dataset_sub.add_parser("validate")
    validate.add_argument("dataset", type=Path)
    prepare = dataset_sub.add_parser("prepare")
    prepare.add_argument("dataset", type=Path)
    prepare.add_argument("output", type=Path)
    train = sub.add_parser("train")
    train.add_argument("config", type=Path)
    export = sub.add_parser("export")
    export.add_argument("config", type=Path)
    export.add_argument("--checkpoint", type=Path, required=True)
    sample = sub.add_parser("sample")
    sample.add_argument("config", type=Path)
    sample.add_argument("--text", default="你好，这是 Ariadne 自定义音色测试。")
    pack = sub.add_parser("pack")
    pack.add_argument("config", type=Path)
    validate_pack = sub.add_parser("validate")
    validate_pack.add_argument("archive", type=Path)
    args = parser.parse_args()

    if args.command == "doctor": doctor()
    elif args.command == "dataset" and args.dataset_command == "validate": validate_dataset(args.dataset)
    elif args.command == "dataset" and args.dataset_command == "prepare": prepare_dataset(args.dataset, args.output)
    elif args.command == "train": train_voice(load_config(args.config))
    elif args.command == "export": export_voice(load_config(args.config), args.checkpoint)
    elif args.command == "sample": synthesize_sample(load_config(args.config), args.text)
    elif args.command == "pack": pack_voice(load_config(args.config))
    elif args.command == "validate": validate_pack_file(args.archive)


def doctor() -> None:
    checks = {
        "python": sys.version.split()[0],
        "wsl": "microsoft" in Path("/proc/version").read_text(encoding="utf-8").lower() if Path("/proc/version").exists() else False,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "git": shutil.which("git") is not None,
        "nvidia_smi": shutil.which("nvidia-smi") is not None,
        "free_gib": round(shutil.disk_usage(Path.cwd()).free / 1024**3, 1),
    }
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    if not checks["wsl"] or not checks["ffmpeg"] or not checks["git"] or not checks["nvidia_smi"]:
        raise SystemExit("Builder doctor failed; run inside the configured WSL2 distribution with GPU support.")
    if checks["free_gib"] < 50:
        raise SystemExit("At least 50 GiB free space is required for checkpoints and caches.")


def validate_dataset(dataset: Path) -> None:
    metadata = dataset / "metadata.csv"
    audio_dir = dataset / "wav"
    if not metadata.is_file() or not audio_dir.is_dir():
        raise SystemExit("Dataset must contain metadata.csv and wav/.")
    rows = read_metadata(metadata)
    if not rows:
        raise SystemExit("metadata.csv is empty.")
    total_seconds = 0.0
    seen: set[str] = set()
    errors: list[str] = []
    for line_number, (name, text) in enumerate(rows, 1):
        if name in seen: errors.append(f"line {line_number}: duplicate audio name {name}")
        seen.add(name)
        if not text.strip(): errors.append(f"line {line_number}: empty transcript")
        path = audio_dir / name
        try:
            with wave.open(str(path), "rb") as wav:
                duration = wav.getnframes() / wav.getframerate()
                total_seconds += duration
                if wav.getnchannels() != 1: errors.append(f"{name}: audio must be mono")
                if wav.getsampwidth() != 2: errors.append(f"{name}: audio must be 16-bit PCM")
                if wav.getframerate() != 22050: errors.append(f"{name}: expected 22050 Hz")
                if duration < 2 or duration > 12: errors.append(f"{name}: duration {duration:.2f}s is outside 2-12s")
        except (FileNotFoundError, wave.Error) as error:
            errors.append(f"{name}: {error}")
    if errors:
        print("\n".join(errors[:100]), file=sys.stderr)
        raise SystemExit(f"Dataset validation failed with {len(errors)} problem(s).")
    print(json.dumps({"utterances": len(rows), "minutes": round(total_seconds / 60, 2)}, ensure_ascii=False))


def prepare_dataset(dataset: Path, output: Path) -> None:
    rows = read_metadata(dataset / "metadata.csv")
    output_audio = output / "wav"
    output_audio.mkdir(parents=True, exist_ok=True)
    prepared: list[tuple[str, str]] = []
    for index, (source_name, text) in enumerate(rows, 1):
        target_name = f"utt-{index:05d}.wav"
        run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(dataset / "wav" / source_name), "-ac", "1", "-ar", "22050",
            "-sample_fmt", "s16", str(output_audio / target_name)
        ])
        prepared.append((target_name, normalize_text(text)))
    with (output / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter="|", lineterminator="\n")
        writer.writerows(prepared)
    validate_dataset(output)


def train_voice(config: dict) -> None:
    doctor()
    paths = config["paths"]
    training = config["training"]
    piper_python = Path(paths["piper_repo"]) / ".venv" / "bin" / "python"
    ensure_piper_checkout(Path(paths["piper_repo"]))
    dataset = Path(paths["dataset"])
    validate_dataset(dataset)
    batch_size = int(training.get("batch_size", 4))
    command = piper_train_command(piper_python, config, batch_size)
    result = subprocess.run(command, text=True, stdout=sys.stdout, stderr=subprocess.PIPE)
    if result.returncode == 0:
        return
    sys.stderr.write(result.stderr)
    if "CUDA out of memory" not in result.stderr or batch_size <= 2:
        raise SystemExit(result.returncode)
    print("CUDA OOM detected; retrying with batch size 2.", file=sys.stderr)
    run(piper_train_command(piper_python, config, 2))


def export_voice(config: dict, checkpoint: Path) -> None:
    paths = config["paths"]
    piper_python = Path(paths["piper_repo"]) / ".venv" / "bin" / "python"
    output = Path(paths["export_dir"])
    output.mkdir(parents=True, exist_ok=True)
    run([
        str(piper_python), "-m", "piper.train.export_onnx",
        "--checkpoint", str(checkpoint.resolve()),
        "--output-file", str((output / "model.onnx").resolve())
    ])
    config_path = Path(paths["voice_config"])
    shutil.copy2(config_path, output / "model.onnx.json")
    write_tokens(config_path, output / "tokens.txt")


def synthesize_sample(config: dict, text: str) -> None:
    paths = config["paths"]
    piper_python = Path(paths["piper_repo"]) / ".venv" / "bin" / "python"
    model = Path(paths["export_dir"]) / "model.onnx"
    sample = Path(paths["sample_wav"])
    sample.parent.mkdir(parents=True, exist_ok=True)
    run([str(piper_python), "-m", "piper", "-m", str(model.resolve()), "-f", str(sample.resolve()), "--", text])
    assert_nonempty_wave(sample)
    print(sample)


def pack_voice(config: dict) -> None:
    voice = config["voice"]
    paths = config["paths"]
    export_dir = Path(paths["export_dir"])
    output_dir = Path(paths["pack_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ariadne-voice-") as temp:
        root = Path(temp) / f"{voice['id']}-{voice['version']}"
        root.mkdir()
        for name in ("model.onnx", "model.onnx.json", "tokens.txt"):
            shutil.copy2(export_dir / name, root / name)
        espeak_source = Path(paths["espeak_data_dir"])
        shutil.copytree(espeak_source, root / "espeak-ng-data")
        sample = Path(paths.get("sample_wav", ""))
        if not sample.is_file():
            raise SystemExit("paths.sample_wav must point to a reviewed synthesized sample.wav.")
        shutil.copy2(sample, root / "sample.wav")
        model_card = Path(paths["model_card"])
        shutil.copy2(model_card, root / "MODEL_CARD.md")
        manifest = {
            "schemaVersion": 1,
            "engine": "sherpa-onnx-vits",
            "voiceId": voice["id"],
            "version": voice["version"],
            "displayName": voice["display_name"],
            "languages": voice.get("languages", ["zh-CN"]),
            "sampleRate": int(voice.get("sample_rate", 22050)),
            "speakerId": int(voice.get("speaker_id", 0)),
            "files": {
                "model": "model.onnx", "config": "model.onnx.json", "tokens": "tokens.txt",
                "dataDir": "espeak-ng-data", "sample": "sample.wav", "modelCard": "MODEL_CARD.md"
            },
            "license": {
                "name": voice["license_name"],
                "url": voice.get("license_url", "https://example.invalid/local-voice-license"),
                "redistributionAllowed": bool(voice.get("redistribution_allowed", False))
            }
        }
        (root / "voice.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        checksums = {
            path.relative_to(root).as_posix(): sha256(path)
            for path in root.rglob("*")
            if path.is_file() and path.name != "checksums.json"
        }
        (root / "checksums.json").write_text(json.dumps(checksums, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        archive = output_dir / f"{voice['id']}-{voice['version']}.avp"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(root, arcname=root.name, recursive=True)
    validate_pack_file(archive)
    print(archive)


def validate_pack_file(archive: Path) -> None:
    with tarfile.open(archive, "r:*") as tar:
        members = tar.getmembers()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                raise SystemExit(f"Unsafe archive entry: {member.name}")
        manifests = [member for member in members if Path(member.name).name == "voice.json"]
        if len(manifests) != 1: raise SystemExit("Archive must contain exactly one voice.json.")
        with tempfile.TemporaryDirectory(prefix="ariadne-voice-validate-") as temp:
            tar.extractall(temp, filter="data")
            root = Path(temp) / Path(manifests[0].name).parent
            manifest = json.loads((root / "voice.json").read_text(encoding="utf-8"))
            if manifest.get("schemaVersion") != 1 or manifest.get("engine") != "sherpa-onnx-vits":
                raise SystemExit("Unsupported voice manifest.")
            checksums = json.loads((root / "checksums.json").read_text(encoding="utf-8"))
            for relative, expected in checksums.items():
                if sha256(root / relative) != expected: raise SystemExit(f"Checksum mismatch: {relative}")
            synthesize_pack_test(root)
    print(f"Validated {archive}")


def ensure_piper_checkout(root: Path) -> None:
    if not root.exists():
        run(["git", "clone", "--branch", PIPER_TAG, "--depth", "1", "https://github.com/OHF-Voice/piper1-gpl.git", str(root)])
    commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    if commit != PIPER_COMMIT: raise SystemExit(f"Unexpected Piper revision: {commit}")
    python = root / ".venv" / "bin" / "python"
    if not python.exists():
        run([sys.executable, "-m", "venv", str(root / ".venv")])
        run([str(python), "-m", "pip", "install", "-e", f"{root}[train]"])
        run(["bash", str(root / "build_monotonic_align.sh")], cwd=root)
        run([str(python), "setup.py", "build_ext", "--inplace"], cwd=root)


def piper_train_command(python: Path, config: dict, batch_size: int) -> list[str]:
    paths = config["paths"]
    voice = config["voice"]
    training = config["training"]
    dataset = Path(paths["dataset"])
    return [
        str(python), "-m", "piper.train", "fit",
        "--data.voice_name", voice["id"],
        "--data.csv_path", str((dataset / "metadata.csv").resolve()),
        "--data.audio_dir", str((dataset / "wav").resolve()),
        "--data.espeak_voice", training.get("espeak_voice", "cmn"),
        "--data.cache_dir", str(Path(paths["cache_dir"]).resolve()),
        "--data.config_path", str(Path(paths["voice_config"]).resolve()),
        "--data.batch_size", str(batch_size),
        "--data.num_workers", str(training.get("num_workers", 2)),
        "--model.sample_rate", str(voice.get("sample_rate", 22050)),
        "--trainer.accelerator", "gpu", "--trainer.devices", "1",
        "--trainer.precision", "16-mixed",
        "--trainer.accumulate_grad_batches", str(training.get("gradient_accumulation", 4)),
        "--trainer.default_root_dir", str(Path(paths["checkpoint_dir"]).resolve()),
        "--ckpt_path", str(Path(paths["base_checkpoint"]).resolve())
    ]


def load_config(path: Path) -> dict:
    with path.open("rb") as handle: return tomllib.load(handle)


def read_metadata(path: Path) -> list[tuple[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.reader(handle, delimiter="|"))
    return [(row[0].strip(), "|".join(row[1:]).strip()) for row in rows if len(row) >= 2]


def normalize_text(text: str) -> str:
    return " ".join(text.replace("\u3000", " ").split())


def write_tokens(config_path: Path, output: Path) -> None:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    mapping = config.get("phoneme_id_map")
    if not isinstance(mapping, dict): raise SystemExit("Piper config has no phoneme_id_map.")
    pairs = sorted(((phoneme, ids[0]) for phoneme, ids in mapping.items() if ids), key=lambda item: item[1])
    output.write_text("".join(f"{phoneme} {identifier}\n" for phoneme, identifier in pairs), encoding="utf-8")


def synthesize_pack_test(root: Path) -> None:
    try:
        from piper import PiperVoice
    except ImportError as error:
        raise SystemExit("Real voice-pack validation requires the pinned piper-tts dependency.") from error
    voice = PiperVoice.load(str(root / "model.onnx"), config_path=str(root / "model.onnx.json"))
    output = root / ".validation.wav"
    with wave.open(str(output), "wb") as wav_file:
        voice.synthesize_wav("你好，这是 Ariadne 语音包验证。", wav_file)
    assert_nonempty_wave(output)
    output.unlink()


def assert_nonempty_wave(path: Path) -> None:
    with wave.open(str(path), "rb") as wav_file:
        if wav_file.getnchannels() != 1 or wav_file.getnframes() == 0 or wav_file.getframerate() < 8000:
            raise SystemExit(f"Synthesized sample is invalid: {path}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str], cwd: Path | None = None) -> None:
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    main()
