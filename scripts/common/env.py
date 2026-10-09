"""Carga opcional de variables desde un archivo .env (KEY=VALUE por línea).

Las variables ya definidas en el entorno tienen prioridad sobre el archivo.
"""

from __future__ import annotations

import os
from pathlib import Path


def load_env_file(path: str | Path) -> bool:
    path = Path(path)
    if not path.is_file():
        return False
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)
    return True
