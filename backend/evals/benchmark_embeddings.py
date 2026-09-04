import json
import os
import time
from pathlib import Path

from backend.app.embeddings import configured_embedder
from backend.app.settings import Settings


def rss_megabytes() -> float | None:
    status = Path("/proc/self/status")
    if status.exists():
        for line in status.read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                return round(int(line.split()[1]) / 1024, 1)
    return None


def main() -> None:
    settings = Settings()
    embedder = configured_embedder(settings)
    document = (
        "Mental skills for performing under pressure. Athletes describe concentration, "
        "composure, distraction, and recovery after a difficult match."
    )
    started = time.perf_counter()
    cpu_started = time.process_time()
    embedder.embed_documents([document])
    cold_seconds = time.perf_counter() - started
    cold_cpu_seconds = time.process_time() - cpu_started
    batches = []
    for size in (1, 8, 32):
        samples = [f"{document} Sample {index}." for index in range(size)]
        started = time.perf_counter()
        cpu_started = time.process_time()
        embedder.embed_documents(samples)
        elapsed = time.perf_counter() - started
        batches.append({
            "batch_size": size,
            "wall_seconds": round(elapsed, 4),
            "cpu_seconds": round(time.process_time() - cpu_started, 4),
            "documents_per_second": round(size / elapsed, 2),
        })
    print(json.dumps({
        "model": embedder.model_name,
        "revision": embedder.model_revision,
        "dimensions": embedder.dimensions,
        "offline": settings.embedding_offline or os.environ.get("HF_HUB_OFFLINE") == "1",
        "cold_start_wall_seconds": round(cold_seconds, 4),
        "cold_start_cpu_seconds": round(cold_cpu_seconds, 4),
        "resident_memory_mb": rss_megabytes(),
        "batches": batches,
    }, indent=2))


if __name__ == "__main__":
    main()
