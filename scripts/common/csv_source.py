"""Lectura de CSV de origen."""

from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Any


def read_rows(path: str | Path, delimiter: str = ",") -> tuple[list[str], list[dict[str, str]]]:
    """Lee un CSV UTF-8 (con o sin BOM) y devuelve (columnas, filas)."""
    return parse_rows(Path(path).read_bytes(), delimiter)


def parse_rows(
    data: bytes,
    delimiter: str = ",",
    repair_column: str | None = None,
    info: dict[str, Any] | None = None,
) -> tuple[list[str], list[dict[str, str]]]:
    """Como read_rows, pero a partir de los bytes ya leídos (los mismos que se hashean).

    repair_column: si una fila trae más campos que el encabezado porque esa columna
    contiene el delimitador sin comillas (p. ej. eventname de Sara), los campos
    sobrantes se vuelven a unir en esa columna. Sin repair_column, los sobrantes
    se descartan. Si se pasa `info`, recibe {"repaired": n, "dropped": n}.
    """
    text = data.decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    columns = [name.strip() for name in next(reader, [])]
    width = len(columns)
    lowered = [c.lower() for c in columns]
    repair_at = lowered.index(repair_column.lower()) if repair_column and repair_column.lower() in lowered else None
    repaired = dropped = 0

    rows: list[dict[str, str]] = []
    for fields in reader:
        if not fields or (len(fields) == 1 and not fields[0].strip()):
            continue  # línea vacía
        extra = len(fields) - width
        if extra > 0:
            if repair_at is not None:
                merged = delimiter.join(fields[repair_at:repair_at + extra + 1])
                fields = fields[:repair_at] + [merged] + fields[repair_at + extra + 1:]
                repaired += 1
            else:
                fields = fields[:width]
                dropped += 1
        rows.append({name: (fields[i] if i < len(fields) else "") for i, name in enumerate(columns)})

    if info is not None:
        info.update({"repaired": repaired, "dropped": dropped})
    return columns, rows
