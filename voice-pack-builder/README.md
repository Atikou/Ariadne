# Ariadne Voice Pack Builder

独立的 WSL2 Piper/VITS 普通话训练、ONNX 导出和 `.avp` 打包工具，不属于 Ariadne 根 workspace，也不是应用运行依赖。

1. 先用 `scripts/install-wsl-builder.ps1 -StageOnly` 把 Builder 源码部署到 `E:\AI\AriadneSpeech\builder`。
2. 用 `scripts/download-ubuntu-wsl.ps1` 下载并校验官方 Ubuntu 24.04.4 WSL 镜像。
3. 管理员 PowerShell 执行 `wsl.exe --install --no-distribution`，需要时重启；再用 `scripts/install-wsl-builder.ps1 -UbuntuRootFsArchive E:\AI\AriadneSpeech\builder\images\ubuntu-24.04.4-wsl-amd64.wsl` 把发行版数据盘导入 `E:\AI\AriadneSpeech\wsl`。
4. 安装脚本会创建独立 Python 环境并安装 `ariadne-voice`。
5. 运行 `ariadne-voice doctor`、`dataset prepare/validate`、`train`、`export`、`sample`、`pack`、`validate`；`validate` 默认做一次真实试合成。

训练代码固定使用 OHF-Voice Piper `v1.4.2`（GPL-3.0）和已核验提交。模型/数据集授权写入每个包的 `MODEL_CARD.md`；默认只允许本地使用。
