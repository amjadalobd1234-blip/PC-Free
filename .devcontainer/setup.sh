#!/bin/bash
# PC-Free — Codespaces Auto Setup (optional Ofoq video-agent support)
set -euo pipefail

# Resolve paths from this script, not the caller's current directory.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo "🔧 إعداد PC-Free..."
echo ""

echo "📦 [1/6] تثبيت المتطلبات النظامية..."
sudo apt-get update -qq
sudo apt-get install -y -qq \
  gfortran \
  ffmpeg \
  build-essential \
  python3-dev \
  python3-venv \
  wget

echo ""
echo "📦 [2/6] تثبيت Node packages للمشروع..."
if [ -f package.json ]; then
  npm install
else
  echo "ℹ️ لا يوجد package.json في الجذر؛ تم تخطي هذه الخطوة."
fi

echo ""
echo "📦 [3/6] تثبيت video-agent packages..."
if [ -d tools/video-agent ]; then
  cd tools/video-agent
  if [ -f package.json ]; then
    npm install
  else
    echo "ℹ️ لا يوجد package.json في video-agent؛ تم تخطي حزم Node."
  fi

  echo ""
  echo "🐍 [4/6] إنشاء Python venv..."
  python3.11 -m venv .venv
  PYTHON="$PWD/.venv/bin/python"
  "$PYTHON" -m pip install --upgrade pip -q

  echo ""
  echo "📦 [5/6] تثبيت Python packages..."
  "$PYTHON" -m pip install numpy -q
  "$PYTHON" -m pip install scipy -q
  "$PYTHON" -m pip install piper-tts -q

  echo "🔥 تثبيت PyTorch (CPU)..."
  "$PYTHON" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu -q
  "$PYTHON" -m pip install librosa soundfile -q

  echo ""
  echo "🎤 [6/6] تحميل النماذج..."
  mkdir -p assets/models/piper
  MODEL_BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/ar/ar_JO/kareem/medium"
  MODEL_WARNING=0
  for filename in ar_JO-kareem-medium.onnx ar_JO-kareem-medium.onnx.json; do
    target="assets/models/piper/$filename"
    # Retry missing/empty files independently; never leave partial final files.
    if [ ! -s "$target" ]; then
      echo "   تحميل $filename..."
      if wget -q --timeout=30 --tries=3 -O "$target.part" "$MODEL_BASE_URL/$filename" && [ -s "$target.part" ]; then
        mv -- "$target.part" "$target"
      else
        rm -f -- "$target.part"
        echo "⚠️ فشل تحميل $filename؛ أعد تشغيل bash .devcontainer/setup.sh من جذر المستودع للمحاولة مجدداً."
        MODEL_WARNING=1
      fi
    fi
  done

  echo ""
  if [ "$MODEL_WARNING" -eq 1 ]; then
    echo "⚠️ تم تثبيت المتطلبات، لكن نماذج الصوت غير مكتملة."
  else
    echo "✅ تم الإعداد بنجاح!"
  fi
  if [ -f package.json ]; then
    echo "للتشغيل من جذر المستودع (إذا كان المشروع يعرّف start):"
    echo "  cd tools/video-agent"
    echo "  source .venv/bin/activate"
    echo "  npm start"
  fi
else
  echo "ℹ️ tools/video-agent غير موجود؛ تم تخطي الخطوات 4–6 دون إنشاء ملفات أو تنزيل نماذج."
  echo "✅ تم إعداد متطلبات PC-Free بنجاح!"
fi
