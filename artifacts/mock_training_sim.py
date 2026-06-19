import math
import os
import random
import time
from pathlib import Path


def emit(line: str, log_file):
    print(line, flush=True)
    log_file.write(line + "\n")
    log_file.flush()


def main():
    workspace = Path.cwd()
    log_path = workspace / "artifacts" / "mock_training_monitor.log"
    pid_path = workspace / "artifacts" / "mock_training_monitor.pid"

    pid_path.write_text(str(os.getpid()) + "\n", encoding="utf-8")

    loss = 2.75
    acc = 0.18
    step = 0

    with log_path.open("a", encoding="utf-8") as log_file:
        emit(f"mock-training-sim started pid={os.getpid()} cwd={workspace}", log_file)

        while True:
            step += 1
            epoch = (step - 1) // 50 + 1
            loss = max(0.05, loss * 0.992 + random.uniform(-0.025, 0.018))
            acc = min(0.995, acc + random.uniform(0.0005, 0.004))
            lr = 3e-4 * (0.5 * (1 + math.cos(min(step, 1000) / 1000 * math.pi)))
            gpu_mem = 1024 + (step % 37) * 13 + random.randint(-8, 8)

            emit(
                f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] "
                f"epoch={epoch:03d} step={step:06d} loss={loss:.4f} "
                f"acc={acc:.4f} lr={lr:.6f} gpu_mem={gpu_mem}MiB",
                log_file,
            )
            time.sleep(2)


if __name__ == "__main__":
    main()
