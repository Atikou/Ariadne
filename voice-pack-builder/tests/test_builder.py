from __future__ import annotations

import csv
from pathlib import Path
import tempfile
import unittest
import wave

from ariadne_voice_builder.cli import normalize_text, piper_train_command, validate_dataset


class DatasetValidationTests(unittest.TestCase):
    def test_accepts_a_normalized_mono_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            audio = root / "wav"
            audio.mkdir()
            with wave.open(str(audio / "one.wav"), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(22050)
                output.writeframes(b"\x00\x00" * 22050 * 2)
            with (root / "metadata.csv").open("w", encoding="utf-8", newline="") as handle:
                csv.writer(handle, delimiter="|").writerow(["one.wav", "你好，Ariadne。"])
            validate_dataset(root)

    def test_normalizes_full_width_and_repeated_space(self) -> None:
        self.assertEqual(normalize_text("你好　   Ariadne"), "你好 Ariadne")

    def test_training_command_uses_low_memory_defaults(self) -> None:
        config = {
            "voice": {"id": "test", "sample_rate": 22050},
            "paths": {
                "dataset": "/data", "cache_dir": "/cache", "voice_config": "/config.json",
                "checkpoint_dir": "/checkpoints", "base_checkpoint": "/base.ckpt"
            },
            "training": {"batch_size": 4, "gradient_accumulation": 4, "num_workers": 2}
        }
        command = piper_train_command(Path("/venv/python"), config, 4)
        self.assertIn("16-mixed", command)
        self.assertEqual(command[command.index("--data.batch_size") + 1], "4")
        self.assertEqual(command[command.index("--trainer.accumulate_grad_batches") + 1], "4")
        self.assertEqual(command[command.index("--data.num_workers") + 1], "2")


if __name__ == "__main__":
    unittest.main()
