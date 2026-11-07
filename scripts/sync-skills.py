"""Sync the Wox skills and retain this project's scaffold integration."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent.parent
names = ("wox-plugin-creator", "wox-plugin-submit2store")

with tempfile.TemporaryDirectory() as temp:
    upstream = Path(temp) / "wox"
    subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
                    "https://github.com/Wox-launcher/Wox.git", str(upstream)], check=True)
    subprocess.run(["git", "-C", str(upstream), "sparse-checkout", "set", "--",
                    *(f".agents/skills/{name}" for name in names)], check=True)
    source = upstream / ".agents/skills"
    for name in names:
        if not (source / name / "SKILL.md").is_file():
            raise SystemExit(f"Upstream skill not found: {name}")
    subprocess.run([sys.executable, str(root / "scripts/adapt-synced-skill.py"),
                    str(source / names[0])], check=True)
    for name in names:
        target = root / ".agents/skills" / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source / name, target)

subprocess.run([sys.executable, str(root / "scripts/test-scaffold.py")], cwd=root, check=True)
