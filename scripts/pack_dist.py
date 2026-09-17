# -*- coding: utf-8 -*-
"""打包给同事：不含个人账号/Cookie/运行缓存"""
from pathlib import Path
import json, shutil, zipfile, sys

root = Path(__file__).resolve().parent.parent
out_parent = root / "分发包"
out_dir = out_parent / "BUG校验工具"
if out_parent.exists():
    shutil.rmtree(out_parent)

# 保持与源码相同的目录结构
# 注意：只「复制」根目录的使用方法.md/.docx 到分发包，不改写源文件；
# docs\ 为维护者文档，不进分发包。
pairs = [
    ("src/validate-server.js", "src/validate-server.js"),
    ("src/module-data.js", "src/module-data.js"),
    ("package.json", "package.json"),
    ("package-lock.json", "package-lock.json"),
    ("scripts/notify.ps1", "scripts/notify.ps1"),
    ("scripts/install-node.ps1", "scripts/install-node.ps1"),
    ("scripts/start.vbs", "scripts/start.vbs"),
    ("scripts/tray.ps1", "scripts/tray.ps1"),
    ("scripts/tray.vbs", "scripts/tray.vbs"),
    ("start.bat", "start.bat"),
    ("stop.bat", "stop.bat"),
    ("install.bat", "install.bat"),
    ("run-once.vbs", "run-once.vbs"),
    ("使用方法.md", "使用方法.md"),
    ("使用方法.docx", "使用方法.docx"),
]
missing = []
for src_rel, dst_rel in pairs:
    src = root / src_rel
    dst = out_dir / dst_rel
    if src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    else:
        missing.append(src_rel)

# 空配置模板
(out_dir / "data").mkdir(parents=True, exist_ok=True)
cfg = {
    "username": "", "password_b64": "",
    "listUrl": "work_packages?query_id=4351",
    "versionOrder": "1.16.0、1.15.0、1.14.11、1.12.10",
    "responsible": "黄贵良", "tester": "",
    "dingtalkEnabled": False, "dingtalkWebhook": "", "dingtalkSecret": "",
}
(out_dir / "data" / "login_config.json").write_text(
    json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
)

np = out_dir / "scripts" / "notify.ps1"
if np.exists():
    text = np.read_text(encoding="utf-8")
    if not text.startswith("﻿"):
        np.write_bytes(b"\xef\xbb\xbf" + text.encode("utf-8"))

zip_path = out_parent / "BUG校验工具.zip"
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for p in out_dir.rglob("*"):
        if p.is_file():
            z.write(p, p.relative_to(out_parent))

print("打包完成")
print("文件夹:", out_dir)
print("压缩包:", zip_path, f"({zip_path.stat().st_size} bytes)")
if missing:
    print("警告缺少:", ", ".join(missing))
sys.exit(1 if missing else 0)
