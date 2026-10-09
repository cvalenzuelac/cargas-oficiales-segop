"""Hace importables los módulos de scripts/ desde los tests.

Ejecutar desde la raíz del repo:  python -m unittest discover -s tests
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
FIXTURES = ROOT / "fixtures"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
