#!/bin/bash
echo "========================================"
echo "  视频合并工具 - 一键打包"
echo "========================================"
echo ""

START=$(date +%H:%M:%S)
echo "开始时间: $START"
echo ""

npm run dist
if [ $? -ne 0 ]; then
    echo ""
    echo "[失败] 打包出错，请检查上方错误信息"
    exit 1
fi

echo ""
echo "========================================"
echo "  打包完成！"
echo "  安装包: dist/video-merger-1.0.0-setup.exe"
echo "  开始: $START  结束: $(date +%H:%M:%S)"
echo "========================================"
echo ""

explorer.exe dist 2>/dev/null || xdg-open dist 2>/dev/null
