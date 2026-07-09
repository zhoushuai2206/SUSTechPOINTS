#!/usr/bin/env bash
# =============================================================================
# 半自动标注可选后端：OpenPCDet 环境一键安装脚本
#
# 用途：为 SUSTechPOINTS 的 /auto_annotate 接入 CenterPoint / PointPillars 等
# 深度检测模型。装完后按 doc/pre_annotate_integration.md 修改
# algos/detector_config.json 即可切换。
#
# 用法：
#   bash setup_openpcdet.sh                # 默认 CUDA 11.8 + PointPillars 权重占位
#   bash setup_openpcdet.sh --cuda 12.1    # 指定 CUDA
#   bash setup_openpcdet.sh --skip-weights # 只装环境，不下权重
#   bash setup_openpcdet.sh --help
#
# 注意：
#   1. 建议使用独立 conda/venv 环境，不要污染 tf_env。
#   2. 权重下载受网络与授权影响，脚本失败时会给出手动下载链接。
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
CUDA_TAG="cu118"
SKIP_WEIGHTS=0
VENV_DIR="pcdet_env"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cuda)
            case "$2" in
                11.8) CUDA_TAG="cu118" ;;
                12.1) CUDA_TAG="cu121" ;;
                11.7) CUDA_TAG="cu117" ;;
                *) log_error "仅支持 --cuda 11.7 / 11.8 / 12.1，收到: $2"; exit 1 ;;
            esac
            shift 2
            ;;
        --skip-weights) SKIP_WEIGHTS=1; shift ;;
        --venv)  VENV_DIR="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,20p' "$0"
            exit 0
            ;;
        *) log_warn "未知参数: $1"; shift ;;
    esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"
log_info "工作目录: ${C_BOLD}$SCRIPT_DIR${C_RESET}"
log_info "CUDA_TAG=$CUDA_TAG, VENV_DIR=$VENV_DIR, SKIP_WEIGHTS=$SKIP_WEIGHTS"

# ---------- 1. 选择 python ----------
PYTHON_BIN=""
for cand in python3.10 python3.11 python3.9 python3; do
    if command -v "$cand" &>/dev/null; then
        PYTHON_BIN="$(command -v "$cand")"
        PY_VER="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
        case "$PY_VER" in
            3.9|3.10|3.11) break ;;
            *) PYTHON_BIN="" ;;
        esac
    fi
done
if [ -z "$PYTHON_BIN" ]; then
    log_error "未找到合适 python (需 3.9/3.10/3.11)"; exit 1
fi
log_ok "Python: $PYTHON_BIN ($PY_VER)"

# ---------- 2. 创建虚拟环境 ----------
if [ ! -d "$VENV_DIR" ]; then
    log_info "创建虚拟环境 $VENV_DIR/ ..."
    "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"
log_ok "激活虚拟环境: $(python -c 'import sys; print(sys.executable)')"

python -m pip install --upgrade pip setuptools wheel \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn

# ---------- 3. 装 torch ----------
case "$CUDA_TAG" in
    cu118) TORCH_URL="https://download.pytorch.org/whl/cu118" ;;
    cu121) TORCH_URL="https://download.pytorch.org/whl/cu121" ;;
    cu117) TORCH_URL="https://download.pytorch.org/whl/cu117" ;;
esac
log_info "安装 torch (from $TORCH_URL) ..."
pip install torch==2.1.0 torchvision==0.16.0 --index-url "$TORCH_URL" || {
    log_warn "从官方 wheel 装 torch 失败，尝试默认 pypi 版本（可能是 CPU 版）"
    pip install torch==2.1.0 torchvision==0.16.0
}

# ---------- 4. 装 spconv ----------
log_info "安装 spconv-$CUDA_TAG ..."
pip install "spconv-${CUDA_TAG}" || log_warn "spconv 安装失败，请手动装：pip install spconv-${CUDA_TAG}"

# ---------- 5. 装 OpenPCDet ----------
if [ ! -d third_party/OpenPCDet ]; then
    mkdir -p third_party
    log_info "克隆 OpenPCDet ..."
    git clone --depth 1 https://github.com/open-mmlab/OpenPCDet.git third_party/OpenPCDet || {
        log_error "git clone 失败，请检查网络或手动 clone 到 third_party/OpenPCDet"
        exit 1
    }
fi
pushd third_party/OpenPCDet >/dev/null
pip install -r requirements.txt \
    -i https://pypi.tuna.tsinghua.edu.cn/simple \
    --trusted-host pypi.tuna.tsinghua.edu.cn || true
python setup.py develop
popd >/dev/null

# ---------- 6. 下载权重（占位；OpenPCDet 官方权重多在 google drive/OneDrive） ----------
if [ "$SKIP_WEIGHTS" != "1" ]; then
    mkdir -p algos/models
    WEIGHT_FILE="algos/models/pointpillar_7728.pth"
    if [ -s "$WEIGHT_FILE" ]; then
        log_ok "权重已存在: $WEIGHT_FILE ($(stat -c%s "$WEIGHT_FILE") bytes)"
    else
        log_warn "OpenPCDet 官方权重多为 Google Drive 分享，脚本无法直连。"
        log_warn "请手动下载并保存为：$WEIGHT_FILE"
        log_warn "参考链接（PointPillars KITTI 7728）："
        log_warn "  https://github.com/open-mmlab/OpenPCDet#kitti-3d-object-detection-baselines"
        log_warn "或者用你们自己 fine-tune 的权重。"
    fi
fi

# ---------- 7. 简单自检 ----------
log_info "自检导入 ..."
python - <<'PY'
mods = ["torch", "spconv", "pcdet"]
ok = True
for m in mods:
    try:
        mod = __import__(m)
        print(f"  [OK] {m}: {getattr(mod, '__version__', '?')}")
    except Exception as e:
        ok = False
        print(f"  [FAIL] {m}: {e}")
import sys; sys.exit(0 if ok else 1)
PY

# ---------- 8. 提示 ----------
cat <<EOF

${C_GREEN}${C_BOLD}========== OpenPCDet 环境就绪 ==========${C_RESET}

下一步：
  1. 修改 ${C_BOLD}algos/detector_config.json${C_RESET}，把 backend 改成 "openpcdet"，并确认
     config_path / ckpt_path 指向你要用的模型；
  2. 用本 venv 的 python 启动服务：
       ${C_BOLD}source ${VENV_DIR}/bin/activate${C_RESET}
       ${C_BOLD}python main.py${C_RESET}
  3. 访问 http://127.0.0.1:8081/ml_status，确认 backend=openpcdet。

若切换失败会自动回退到 dummy 后端，具体错误看 /ml_status 的 load_fallback_reason
或服务日志 server.log。详见 doc/pre_annotate_integration.md。
EOF
