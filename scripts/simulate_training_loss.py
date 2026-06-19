#!/usr/bin/env python3
"""Simulate a model training loop with a gradually decreasing loss."""

from __future__ import annotations

import argparse
import json
import math
import random
import signal
import sys
import time
from datetime import datetime, timezone


running = True


def handle_stop(_signum: int, _frame: object) -> None:
    global running
    running = False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-loss", type=float, default=3.0)
    parser.add_argument("--floor-loss", type=float, default=0.08)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--decay", type=float, default=0.018)
    parser.add_argument("--noise", type=float, default=0.035)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--max-steps", type=int, default=0, help="0 means run until stopped")
    return parser.parse_args()


def simulated_loss(step: int, args: argparse.Namespace, rng: random.Random) -> float:
    trend = args.floor_loss + (args.start_loss - args.floor_loss) * math.exp(-args.decay * step)
    jitter_scale = args.noise * max(trend - args.floor_loss, 0.01)
    jitter = rng.uniform(-jitter_scale, jitter_scale)
    return max(args.floor_loss, trend + jitter)


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    print(
        json.dumps(
            {
                "event": "started",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "start_loss": args.start_loss,
                "floor_loss": args.floor_loss,
                "interval": args.interval,
            }
        ),
        flush=True,
    )

    step = 0
    while running and (args.max_steps <= 0 or step < args.max_steps):
        step += 1
        loss = simulated_loss(step, args, rng)
        learning_rate = 0.001 * (0.97 ** (step // 100))
        print(
            json.dumps(
                {
                    "event": "train_step",
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "step": step,
                    "loss": round(loss, 6),
                    "learning_rate": round(learning_rate, 8),
                }
            ),
            flush=True,
        )
        time.sleep(args.interval)

    print(
        json.dumps(
            {
                "event": "stopped",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "last_step": step,
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
