#!/usr/bin/env bash
# 构建 pink_mcp_bridge 的 VS Code 插件安装包（.vsix），可选直接安装到 PinK。
#
# 用法：
#   ./build.sh              # 构建 pink-mcp-bridge-<版本>.vsix
#   ./build.sh --install    # 构建后立即用 PinK CLI 安装（重启 PinK 生效）
#
# 依赖：node/npx（首次运行会通过 npx 下载 @vscode/vsce）

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
VSIX="pink-mcp-bridge-${VERSION}.vsix"
PIN_CODE="/Applications/PinK.app/Contents/Resources/app/bin/code"

echo "==> 打包 ${VSIX}"
npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository -o "${VSIX}"

echo "==> 产物: $(pwd)/${VSIX}"

if [[ "${1:-}" == "--install" ]]; then
    if [[ ! -x "$PIN_CODE" ]]; then
        echo "!! 未找到 PinK CLI: $PIN_CODE" >&2
        exit 1
    fi
    echo "==> 用 PinK CLI 安装"
    "$PIN_CODE" --install-extension "$(pwd)/${VSIX}" --force
    echo "==> 已安装，完全重启 PinK 后生效"
fi
