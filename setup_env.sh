#!/usr/bin/env bash
# =============================================================================
# SUSTechPOINTS 环境一键配置脚本
#
# 功能：
#   1. 检查 python3（推荐 3.10，TensorFlow 2.x 兼容性最好）
#   2. 创建虚拟环境 tf_env/
#   3. 安装 requirement.txt 里的依赖
#   4. 检查并提示 algos/models/deep_annotation_inference.h5
#   5. 启动入口提示
#
# 用法：
#   bash setup_env.sh            # 正常安装
#   bash setup_env.sh --force    # 删除已有 tf_env/ 后重装
#   bash setup_env.sh --help
# =============================================================================

set -e

# ---------- 颜色 ----------
if [ -t 1 ]; then
    C_RED="\033[31m"; C_GREEN="\033[32m"; C_YELLOW="\033[33m"
    C_BLUE="\033[34m"; C_BOLD="\033[1m"; C_RESET="\033[0m"
else
    C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_RESET=""
fi

log_info()  { echo -e "${C_BLUE}[INFO]${C_RESET}  $*"; }
log_ok()    { echo -e "${C_GREEN}[ OK ]${C_RESET}  $*"; }
log_warn()  { echo -e "${C_YELLOW}[WARN]${C_RESET}  $*"; }
log_error() { echo -e "${C_RED}[FAIL]${C_RESET}  $*" >&2; }

# ---------- 参数 ----------
FORCE_RECREATE=0
for arg in "$@"; do
    case "$arg" in
        --force|-f)  FORCE_RECREATE=1 ;;
        --help|-h)
            sed -n '2,16p' "$0"
            exit 0
            ;;
        *) log_warn "未知参数: $arg" ;;
    esac
done

# ---------- 切到脚本所在目录 ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"
log_info "工作目录: ${C_BOLD}$SCRIPT_DIR${C_RESET}"

VENV_DIR="tf_env"
REQ_FILE="requirement.txt"
MODEL_FILE="algos/models/deep_annotation_inference.h5"
MODEL_URL="https://github.com/naurril/SUSTechPOINTS/releases/download/0.1/deep_annotation_inference.h5"

# ---------- 1. 选择 python ----------
log_info "检测 Python 解释器..."
PYTHON_BIN=""
for cand in python3.10 python3.11 python3.9 python3.8 python3; do
    if command -v "$cand" &>/dev/null; then
        PYTHON_BIN="$(command -v "$cand")"
        PY_VER="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
        # tensorflow 2.x 一般要求 3.7~3.11
        case "$PY_VER" in
            3.7|3.8|3.9|3.10|3.11) break ;;
            *) PYTHON_BIN="" ;;
        esac
    fi
done

if [ -z "$PYTHON_BIN" ]; then
    log_error "未找到合适的 Python (需要 3.8 ~ 3.11)。请先安装："
    log_error "  sudo apt install python3.10 python3.10-venv python3.10-dev"
    exit 1
fi
log_ok "Python: $PYTHON_BIN ($PY_VER)"

# ---------- 2. 检查 venv 模块 ----------
if ! "$PYTHON_BIN" -c "import venv" &>/dev/null; then
    log_error "$PYTHON_BIN 缺少 venv 模块。请安装："
    log_error "  sudo apt install python${PY_VER}-venv"
    exit 1
fi

# ---------- 3. 创建虚拟环境 ----------
if [ -d "$VENV_DIR" ] && [ "$FORCE_RECREATE" = "1" ]; then
    log_warn "--force 指定，删除已有虚拟环境 $VENV_DIR/"
    rm -rf "$VENV_DIR"
fi

if [ ! -d "$VENV_DIR" ]; then
    log_info "创建虚拟环境 $VENV_DIR/ ..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    log_ok "虚拟环境已创建"
else
    log_ok "复用已有虚拟环境 $VENV_DIR/"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
log_ok "已激活虚拟环境: $(python -c 'import sys; print(sys.executable)')"

# ---------- 4. 升级 pip / wheel ----------
log_info "升级 pip / setuptools / wheel ..."
python -m pip install --upgrade pip setuptools wheel \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn

# ---------- 5. 安装依赖 ----------
if [ ! -f "$REQ_FILE" ]; then
    log_error "找不到 $REQ_FILE"
    exit 1
fi

log_info "安装依赖（$REQ_FILE）..."
# 国内镜像，安装失败时 fallback 到默认源
if ! pip install -r "$REQ_FILE" \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        --trusted-host pypi.tuna.tsinghua.edu.cn ; then
    log_warn "清华源安装失败，回退默认 PyPI 重试..."
    pip install -r "$REQ_FILE"
fi

# numpy 在新版 TF 下可能与之冲突，预防性 pin 一下（TF 2.10 ~ 2.15 兼容 numpy<2）
python - <<'PY' || true
import importlib, sys
try:
    import tensorflow as tf
    print("tensorflow:", tf.__version__)
except Exception as e:
    print("import tensorflow failed:", e)
    sys.exit(0)

import numpy as np
print("numpy:", np.__version__)
if int(np.__version__.split('.')[0]) >= 2:
    print("WARN: numpy>=2 可能与 tensorflow 冲突，将降级到 1.26.x")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "numpy<2"])
PY

# ---------- 6. 模型文件 ----------
log_info "检查算法模型文件 $MODEL_FILE ..."
if [ -s "$MODEL_FILE" ]; then
    SIZE=$(stat -c%s "$MODEL_FILE" 2>/dev/null || stat -f%z "$MODEL_FILE")
    log_ok "模型文件已存在 ($SIZE bytes)"
else
    log_warn "缺少模型文件，尝试下载..."
    mkdir -p "$(dirname "$MODEL_FILE")"
    if command -v wget &>/dev/null; then
        wget -c "$MODEL_URL" -O "$MODEL_FILE" || log_warn "wget 下载失败"
    elif command -v curl &>/dev/null; then
        curl -L -o "$MODEL_FILE" "$MODEL_URL" || log_warn "curl 下载失败"
    else
        log_warn "未发现 wget/curl，请手动下载："
        log_warn "  $MODEL_URL"
        log_warn "  保存到 $MODEL_FILE"
    fi
    if [ ! -s "$MODEL_FILE" ]; then
        log_warn "模型文件未就绪，自动标注 / 旋转预测功能将无法使用，但标注工具其他功能可正常运行。"
    fi
fi

# ---------- 7. 简单自检 ----------
log_info "运行简单自检 ..."
python - <<'PY'
mods = ["cherrypy", "jinja2", "filterpy", "cheroot"]
ok = True
for m in mods:
    try:
        __import__(m)
        print(f"  [OK] {m}")
    except Exception as e:
        ok = False
        print(f"  [FAIL] {m}: {e}")
try:
    import tensorflow as tf
    print(f"  [OK] tensorflow {tf.__version__}")
except Exception as e:
    ok = False
    print(f"  [FAIL] tensorflow: {e}")
import sys
sys.exit(0 if ok else 1)
PY

if [ $? -eq 0 ]; then
    log_ok "依赖自检通过"
else
    log_warn "存在依赖未通过自检，请检查上面输出"
fi

# ---------- 8. 完成提示 ----------
cat <<EOF

${C_GREEN}${C_BOLD}========== 环境配置完成 ==========${C_RESET}

下次使用时只需先激活虚拟环境再启动服务：

    ${C_BOLD}source ${VENV_DIR}/bin/activate${C_RESET}
    ${C_BOLD}python main.py${C_RESET}

然后浏览器访问： ${C_BLUE}http://127.0.0.1:8081${C_RESET}

如需重建环境：${C_BOLD}bash setup_env.sh --force${C_RESET}

EOF
