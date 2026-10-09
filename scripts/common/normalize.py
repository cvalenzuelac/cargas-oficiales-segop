"""Normalización de nombres, correos, fechas y listas.

`normalize_name` tiene un gemelo en `public/js/lib/normalize.js` (el navegador
unifica personas con él); ambos deben producir exactamente la misma salida
(se verifica con fixtures/merge_cases.json).
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime

BOGOTA_OFFSET = "-05:00"
_DATE_FORMATS = ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S")
_WHITESPACE = re.compile(r"\s+")


def normalize_name(value: str | None) -> str:
    """Quita tildes y diacríticos, pasa a minúsculas y colapsa espacios.

    "  José   NÚÑEZ " -> "jose nunez"
    """
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFKD", value)
    without_marks = "".join(ch for ch in decomposed if not unicodedata.category(ch).startswith("M"))
    return _WHITESPACE.sub(" ", without_marks.lower()).strip()


def normalize_email(value: str | None) -> str | None:
    """Correo en minúsculas sin espacios; None si está vacío."""
    if value is None:
        return None
    value = value.strip().lower()
    return value or None


def split_list(value: str | None, separator: str = ";") -> list[str]:
    """Divide un campo "a; b; c" conservando posiciones (los vacíos quedan como "").

    Un campo vacío devuelve []. Conservar posiciones permite detectar
    desalineación entre listas paralelas (Responsables/Correos).
    """
    if value is None or not value.strip():
        return []
    return [part.strip() for part in value.split(separator)]


def split_labels(value: str | None, separator: str = ";") -> list[str]:
    """Como split_list, pero descarta vacíos y duplicados conservando el orden."""
    seen: dict[str, None] = {}
    for part in split_list(value, separator):
        if part:
            seen.setdefault(part, None)
    return list(seen)


def to_iso_bogota(value: str | None) -> str | None:
    """'yyyy-MM-dd HH:mm' (hora de Bogotá) -> 'yyyy-MM-ddTHH:mm:ss-05:00'.

    Devuelve None si el valor está vacío. Lanza ValueError si el formato no es válido.
    """
    if value is None or not value.strip():
        return None
    text = value.strip()
    for fmt in _DATE_FORMATS:
        try:
            parsed = datetime.strptime(text, fmt)
        except ValueError:
            continue
        return parsed.strftime("%Y-%m-%dT%H:%M:%S") + BOGOTA_OFFSET
    raise ValueError(f"fecha con formato inválido: {text!r}")
