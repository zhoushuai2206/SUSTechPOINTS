#!/usr/bin/env bash
# =============================================================================
# SUSTechPOINTS 一键环境安装脚本（conda 版）
#
# 所有依赖统一装到独立 conda env `annotate`：
#   - Web 服务依赖（CherryPy / Jinja2 / numpy<2 ...）
#   - torch 2.1.0 + torchvision 0.16.0 (cu118)
#   - spconv-cu118
#   - CUDA Toolkit 11.8（与 pip 的 cu118 wheels 严格匹配）
#   - OpenPCDet（`python setup.py develop`）
#   - CenterPoint(PointPillars, nuScenes) 权重
#
# 完成后可直接 `bash start.sh` 运行，自动标注开箱即用。
#
# 用法：
#   bash setup_env.sh                # 默认 cu118，env 名 annotate
#   bash setup_env.sh --env myenv    # 自定义 conda env 名
#   bash setup_env.sh --cuda 12.1    # 指定 CUDA 版本（同步调整 cuda-toolkit）
#   bash setup_env.sh --force        # 删除已有 conda env 后重建
#   bash setup_env.sh --skip-weights # 只装环境，不下模型权重
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
SKIP_WEIGHTS=0
CUDA_TAG="cu118"
CUDA_VER="11.8"
ENV_NAME="annotate"
PY_VER="3.10"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --force|-f)       FORCE_RECREATE=1; shift ;;
        --skip-weights)   SKIP_WEIGHTS=1; shift ;;
        --env)            ENV_NAME="$2"; shift 2 ;;
        --python)         PY_VER="$2"; shift 2 ;;
        --cuda)
            case "$2" in
                11.7) CUDA_TAG="cu117"; CUDA_VER="11.7" ;;
                11.8) CUDA_TAG="cu118"; CUDA_VER="11.8" ;;
                12.1) CUDA_TAG="cu121"; CUDA_VER="12.1" ;;
                *) log_error "--cuda 仅支持 11.7 / 11.8 / 12.1，收到: $2"; exit 1 ;;
            esac
            shift 2
            ;;
        -h|--help)
            sed -n '2,22p' "$0"
            exit 0
            ;;
        *) log_warn "未知参数: $1"; shift ;;
    esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"
log_info "工作目录: ${C_BOLD}$SCRIPT_DIR${C_RESET}"
log_info "参数: ENV_NAME=$ENV_NAME, PY_VER=$PY_VER, CUDA=$CUDA_VER($CUDA_TAG), SKIP_WEIGHTS=$SKIP_WEIGHTS, FORCE=$FORCE_RECREATE"

REQ_FILE="requirement.txt"
PCDET_DIR="third_party/OpenPCDet"
CFG_TARGET_SUBDIR="tools/cfgs/nuscenes_models"
CFG_TARGET_NAME="cbgs_dyn_pp_centerpoint.yaml"
WEIGHT_FILE="algos/models/centerpoint_pp.pth"
# 说明：OpenPCDet 的 CenterPoint 权重官方发布在 Google Drive（见 OpenPCDet GETTING_STARTED.md），
# 国内网络直连困难，脚本无法可靠自动下载。tianweiy/CenterPoint 的权重是 det3d 格式，
# 与 OpenPCDet state_dict 结构不兼容，不能直接互换。
# 通过 SUSTECH_CENTERPOINT_URL 环境变量可以指定自建镜像 URL 一键下载。
if [ -n "${SUSTECH_CENTERPOINT_URL:-}" ]; then
    WEIGHT_URLS=("$SUSTECH_CENTERPOINT_URL")
else
    WEIGHT_URLS=()
fi
STAMP_FILE=".setup_done"


# ---------- 1. 检查 conda ----------
if ! command -v conda &>/dev/null; then
    # 尝试从常见位置补上 PATH
    for cand in "$HOME/anaconda3" "$HOME/miniconda3" "/opt/anaconda3" "/opt/miniconda3"; do
        if [ -x "$cand/bin/conda" ]; then
            export PATH="$cand/bin:$PATH"
            break
        fi
    done
fi
if ! command -v conda &>/dev/null; then
    log_error "未检测到 conda。请先安装 Anaconda/Miniconda："
    log_error "  https://docs.conda.io/en/latest/miniconda.html"
    exit 1
fi
CONDA_BIN="$(command -v conda)"
CONDA_ROOT="$(dirname "$(dirname "$CONDA_BIN")")"
log_ok "conda: $CONDA_BIN ($(conda --version))"

# 让 `conda activate` 在非交互 shell 里可用
# shellcheck disable=SC1091
source "$CONDA_ROOT/etc/profile.d/conda.sh"

# ---------- 2. 创建 / 复用 conda env ----------
env_exists() {
    conda env list | awk '{print $1}' | grep -Fxq "$ENV_NAME"
}

if env_exists && [ "$FORCE_RECREATE" = "1" ]; then
    log_warn "--force 指定，删除已有 conda env: $ENV_NAME"
    conda env remove -n "$ENV_NAME" -y
fi

if ! env_exists; then
    log_info "创建 conda env: $ENV_NAME (python=$PY_VER) ..."
    conda create -n "$ENV_NAME" "python=$PY_VER" -y
else
    log_ok "复用已有 conda env: $ENV_NAME"
fi

conda activate "$ENV_NAME"
log_ok "已激活 conda env: $CONDA_PREFIX"
log_ok "python: $(python -c 'import sys; print(sys.executable, sys.version.split()[0])')"

PIP_MIRROR_OPTS=(-i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn)

pip_install() {
    if ! pip install "${PIP_MIRROR_OPTS[@]}" "$@"; then
        log_warn "清华源失败，回退默认 PyPI 重试: $*"
        pip install "$@"
    fi
}

log_info "升级 pip / wheel；把 setuptools 固定在 <70（保留 pkg_resources，torch 2.1 cpp_extension 需要）..."
pip_install --upgrade pip wheel
pip_install "setuptools<70"

# ---------- 3. CUDA Toolkit（装到当前 env）----------
# 用 nvidia label 频道精准锁定版本，避免 conda 求解到别的 (例如最新 13.x)。
CUDA_LABEL="cuda-${CUDA_VER}.0"
log_info "在 $ENV_NAME 里安装 CUDA Toolkit (nvidia/label/${CUDA_LABEL})..."
# 元包 `cuda` 会拉齐 nvcc/cudart/cusparse/cublas
if ! conda install -n "$ENV_NAME" -c "nvidia/label/${CUDA_LABEL}" -c conda-forge cuda -y; then
    log_warn "元包 cuda 安装失败，回退到 cuda-toolkit ..."
    if ! conda install -n "$ENV_NAME" -c "nvidia/label/${CUDA_LABEL}" -c conda-forge cuda-toolkit -y; then
        log_warn "cuda-toolkit 安装失败，回退到 cuda-nvcc + cuda-cudart-dev + libcusparse-dev + libcublas-dev ..."
        conda install -n "$ENV_NAME" -c "nvidia/label/${CUDA_LABEL}" -c conda-forge \
            cuda-nvcc cuda-cudart-dev libcusparse-dev libcublas-dev -y
    fi
fi

# 清 shell 命令缓存，防止还指向 base env 的 nvcc
hash -r 2>/dev/null || true

# 明确 export，覆盖 base env 可能设置的 CUDA_HOME
export CUDA_HOME="$CONDA_PREFIX"
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"

if [ ! -x "$CUDA_HOME/bin/nvcc" ]; then
    log_error "cuda-toolkit 安装完成但 $CUDA_HOME/bin/nvcc 不存在，请检查 conda 输出"
    log_error "可尝试手动装：conda install -n $ENV_NAME -c nvidia/label/${CUDA_LABEL} cuda -y"
    exit 1
fi

NVCC_VER_STR="$($CUDA_HOME/bin/nvcc --version | grep -oE 'release [0-9]+\.[0-9]+' | awk '{print $2}')"
if [ "$NVCC_VER_STR" != "$CUDA_VER" ]; then
    log_error "nvcc 版本 ($NVCC_VER_STR) 与目标 CUDA_VER ($CUDA_VER) 不一致。"
    log_error "  nvcc 路径: $(which nvcc)"
    log_error "  这会导致 torch 编译 OpenPCDet 时报 CUDA_MISMATCH 错误。"
    log_error "  请检查 conda env 里的 cuda-toolkit 版本，或用 --force 重建 env。"
    exit 1
fi
log_ok "CUDA_HOME=$CUDA_HOME"
log_ok "nvcc: $($CUDA_HOME/bin/nvcc --version | tail -1)"
log_ok "which nvcc: $(which nvcc)  (应该指向 $CUDA_HOME/bin/nvcc)"

# ---------- 4. Web 服务依赖 ----------
log_info "安装 Web 服务依赖 ($REQ_FILE) ..."
pip_install -r "$REQ_FILE"

# ---------- 5. torch ----------
TORCH_INDEX="https://download.pytorch.org/whl/${CUDA_TAG}"
log_info "安装 torch 2.1.0 + torchvision 0.16.0 ($TORCH_INDEX) ..."
if ! pip install torch==2.1.0 torchvision==0.16.0 --index-url "$TORCH_INDEX"; then
    log_warn "官方 wheel 失败，回退到 pypi 通用轮子（可能是 CPU 版）"
    pip_install torch==2.1.0 torchvision==0.16.0
fi

# ---------- 6. spconv ----------
log_info "安装 spconv-$CUDA_TAG ..."
if ! pip_install "spconv-${CUDA_TAG}"; then
    log_error "spconv-$CUDA_TAG 安装失败"
    exit 1
fi

# ---------- 6.1 torch_scatter （DynamicPillarVFE 推理需要）----------
log_info "安装 torch_scatter (对齐 torch 2.1.0 + $CUDA_TAG wheel) ..."
if ! pip install torch_scatter -f "https://data.pyg.org/whl/torch-2.1.0+${CUDA_TAG}.html"; then
    log_warn "torch_scatter 官方 wheel 装不上，尝试源码安装（可能会很慢）..."
    pip_install torch_scatter || log_warn "torch_scatter 装不上，DynamicPillar CenterPoint 会报错"
fi


# ---------- 7. OpenPCDet ----------
clone_openpcdet() {
    local url="$1"
    log_info "尝试从 $url 克隆 OpenPCDet ..."
    git clone --depth 1 "$url" "$PCDET_DIR"
}

if [ ! -d "$PCDET_DIR/.git" ] && [ ! -f "$PCDET_DIR/setup.py" ]; then
    mkdir -p "$(dirname "$PCDET_DIR")"
    OPENPCDET_URLS=(
        "${OPENPCDET_REPO_URL:-https://github.com/open-mmlab/OpenPCDet.git}"
        "https://gitee.com/mirrors/OpenPCDet.git"
        "https://ghproxy.com/https://github.com/open-mmlab/OpenPCDet.git"
    )
    cloned=0
    for url in "${OPENPCDET_URLS[@]}"; do
        for attempt in 1 2 3; do
            if clone_openpcdet "$url"; then
                cloned=1
                break 2
            fi
            log_warn "第 $attempt 次 clone 失败 (源: $url)，稍后重试"
            rm -rf "$PCDET_DIR"
            sleep 2
        done
    done
    if [ "$cloned" != "1" ]; then
        log_error "所有源都无法 clone OpenPCDet。请手动 clone 到 $PCDET_DIR 后重跑"
        exit 1
    fi
fi

pushd "$PCDET_DIR" >/dev/null
log_info "安装 OpenPCDet 依赖 ..."
if pip_install -r requirements.txt; then
    log_ok "OpenPCDet requirements 安装完成"
else
    log_warn "OpenPCDet requirements 部分失败，继续尝试主流程"
fi

# 补丁 A：pcdet.datasets/__init__.py 顶层导入 Argo2Dataset 会强制依赖 av2 + kornia，
# 而 av2 会把 numpy 拉到 2.x 破坏 torch 2.1.0。我们只用 nuScenes CenterPoint，
# 直接把 Argo2Dataset 的 import 注释掉。已经改过的话跳过。
if grep -q "^from .argo2.argo2_dataset import Argo2Dataset" pcdet/datasets/__init__.py; then
    log_info "patch pcdet/datasets/__init__.py：注释掉 Argo2Dataset 顶层导入（避免强制依赖 av2）..."
    sed -i "s|^from .argo2.argo2_dataset import Argo2Dataset|# from .argo2.argo2_dataset import Argo2Dataset  # patched: 避免顶层依赖 av2|" pcdet/datasets/__init__.py
    sed -i "s|^    'Argo2Dataset': Argo2Dataset|    # 'Argo2Dataset': Argo2Dataset  # patched|" pcdet/datasets/__init__.py
fi

# 补丁 B：OpenPCDet 里遗留的 np.int / np.float / np.bool / np.long 别名，
# numpy>=1.20 已弃用、>=1.24 直接报 AttributeError。替换成 int64/float64/bool_/int64。
log_info "patch OpenPCDet：np.int → np.int64 等 numpy 1.24+ 兼容修复 ..."
find pcdet -name '*.py' -exec sed -i \
    -e 's/\bnp\.int\b/np.int64/g' \
    -e 's/\bnp\.float\b/np.float64/g' \
    -e 's/\bnp\.bool\b/np.bool_/g' \
    -e 's/\bnp\.long\b/np.int64/g' {} +


log_info "强制回滚 numpy 到 1.26.x（torch 2.1.0 二进制兼容线）..."
pip_install --force-reinstall "numpy<2"
log_info "编译并安装 OpenPCDet (setup.py develop) ..."
python setup.py develop
popd >/dev/null

# ---------- 8. 校验 CenterPoint 配置 ----------
CFG_PATH="$PCDET_DIR/$CFG_TARGET_SUBDIR/$CFG_TARGET_NAME"
if [ ! -f "$CFG_PATH" ]; then
    log_error "CenterPoint 配置未找到: $CFG_PATH"
    exit 1
fi
log_ok "CenterPoint 配置: $CFG_PATH"

# ---------- 9. 下载权重 ----------
mkdir -p "$(dirname "$WEIGHT_FILE")"
if [ "$SKIP_WEIGHTS" = "1" ]; then
    log_warn "--skip-weights 指定，跳过权重下载。请在启动前手动放置权重到 $WEIGHT_FILE"
elif [ -s "$WEIGHT_FILE" ]; then
    SIZE=$(stat -c%s "$WEIGHT_FILE" 2>/dev/null || stat -f%z "$WEIGHT_FILE")
    log_ok "CenterPoint 权重已存在: $WEIGHT_FILE ($SIZE bytes)"
else
    for url in "${WEIGHT_URLS[@]}"; do
        log_info "下载 CenterPoint 权重: $url"
        rm -f "$WEIGHT_FILE"
        if command -v wget &>/dev/null; then
            wget --tries=3 --timeout=30 -c "$url" -O "$WEIGHT_FILE" 2>&1 | tail -5 || true
        elif command -v curl &>/dev/null; then
            curl --connect-timeout 30 --retry 3 -L -o "$WEIGHT_FILE" "$url" || true
        fi
        if [ -s "$WEIGHT_FILE" ]; then
            log_ok "权重下载完成: $WEIGHT_FILE ($(stat -c%s "$WEIGHT_FILE") bytes) from $url"
            break
        fi
        log_warn "从 $url 下载失败，尝试下一个源"
    done
    if [ ! -s "$WEIGHT_FILE" ]; then
        log_warn "===================================================================="
        log_warn "CenterPoint 权重未自动下载。环境本身已就绪，但自动标注要能工作，"
        log_warn "需要手动放置 OpenPCDet 兼容的 CenterPoint(PointPillars, nuScenes) 权重到："
        log_warn "  $WEIGHT_FILE"
        log_warn ""
        log_warn "获取方式（三选一）："
        log_warn "  1) OpenPCDet 官方权重列表（需要科学上网访问 Google Drive）："
        log_warn "     https://github.com/open-mmlab/OpenPCDet#nuscenes-3d-object-detection-baselines"
        log_warn "     下载 cbgs_dyn_pp_centerpoint.pth 后 mv 到上面的路径"
        log_warn ""
        log_warn "  2) 若有内网镜像，设置环境变量后重跑："
        log_warn "     export SUSTECH_CENTERPOINT_URL=https://your.mirror/xxx.pth"
        log_warn "     bash setup_env.sh"
        log_warn ""
        log_warn "  3) 用自家训练/微调的 .pth：直接把文件放到 $WEIGHT_FILE"
        log_warn ""
        log_warn "注意：https://github.com/tianweiy/CenterPoint 提供的权重是 det3d 格式，"
        log_warn "     与 OpenPCDet state_dict 结构不兼容，不能直接使用（需转换脚本）。"
        log_warn "===================================================================="
        WEIGHT_MISSING=1
    fi
fi

# ---------- 10. 自检 ----------
log_info "运行导入自检 ..."
python - <<'PY'
import sys
mods_core = ["cherrypy", "jinja2", "cheroot", "numpy", "filterpy"]
mods_ml   = ["torch", "spconv", "pcdet"]
ok = True
for m in mods_core + mods_ml:
    try:
        mod = __import__(m)
        print(f"  [OK] {m}: {getattr(mod, '__version__', '?')}")
    except Exception as e:
        ok = False
        print(f"  [FAIL] {m}: {e}")
# detector_status: 权重缺失时 available=false 是可接受的（脚本已经警告过），
# 只要能 import 到 detector 层就算环境层面就绪。
try:
    from algos import detectors
    st = detectors.detector_status()
    print(f"  [INFO] detector_status: {st}")
except Exception as e:
    ok = False
    print(f"  [FAIL] detector import: {e}")
sys.exit(0 if ok else 1)
PY

if [ $? -eq 0 ]; then
    log_ok "环境自检通过"
    date > "$STAMP_FILE"
    if [ "${WEIGHT_MISSING:-0}" = "1" ]; then
        log_warn "注意：CenterPoint 权重缺失，服务能起来但 /auto_annotate 会返回错误。"
        log_warn "     放置权重到 $WEIGHT_FILE 后，无需重装，直接 bash start.sh 即可。"
    fi
else
    log_error "自检失败，请查看上面日志"
    exit 1
fi

# ---------- 11. 完成提示 ----------
cat <<EOF

${C_GREEN}${C_BOLD}========== 环境安装完成 ==========${C_RESET}

启动服务：
    ${C_BOLD}bash start.sh${C_RESET}

浏览器访问： ${C_BLUE}http://127.0.0.1:8081${C_RESET}
状态检查：   ${C_BLUE}curl http://127.0.0.1:8081/ml_status${C_RESET}

如需手动激活环境：
    ${C_BOLD}conda activate $ENV_NAME${C_RESET}

如需重建：${C_BOLD}bash setup_env.sh --force${C_RESET}
EOF
