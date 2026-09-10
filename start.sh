#!/usr/bin/env bash
# =============================================================================
# SUSTechPOINTS 启动脚本（conda 版）
# -----------------------------------------------------------------------------
# 若被 `sh start.sh` 调起（POSIX shell 如 dash），自动用 bash 重执行。
if [ -z "${BASH_VERSION:-}" ]; then
    if command -v bash >/dev/null 2>&1; then
        exec bash "$0" "$@"
    else
        echo "[FAIL] 需要 bash 运行本脚本，请先安装 bash" >&2
        exit 1
    fi
fi
#
# 功能：
#   1. 激活 conda env `bevfusion`（可通过 $SUSTECH_CONDA_ENV 覆盖）；
#      本地 BEVFusion ONNX 自动标注复用该环境，无需额外安装。
#   2. 启动 CherryPy 服务（main.py）
#
# 用法：
#   bash start.sh              前台启动，Ctrl+C 停止
#   bash start.sh -d           后台启动，日志写入 server.log
#   bash start.sh --stop       停止后台进程
#   bash start.sh --status     查看后台进程状态
#   bash start.sh --env myenv  自定义 conda env 名（默认 bevfusion）
#   bash start.sh --help
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

print_help() {
    cat <<'EOF'
SUSTechPOINTS 启动脚本

用法：
    bash start.sh              前台启动，Ctrl+C 停止
    bash start.sh -d           后台启动，日志写入 server.log
    bash start.sh --stop       停止后台进程
    bash start.sh --status     查看后台进程状态
    bash start.sh --env NAME   指定 conda env 名（默认 bevfusion）
    bash start.sh --help       查看帮助

自动标注依赖 conda env `bevfusion`（已装好 onnxruntime/numpy），
运行时会加载 algos/models/model.onnx 完成 CCRS 单帧 / 整 clip 推理。
EOF
}

# ---------- 切到脚本目录 ----------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

# 本地 BEVFusion ONNX 自动标注依赖已有的 bevfusion 环境。
ENV_NAME="${SUSTECH_CONDA_ENV:-bevfusion}"
ENTRY="main.py"
CONF="server/server.conf"
LOG_FILE="server/server.log"
PID_FILE="server/.server.pid"
MODEL_FILE="algos/models/model.onnx"
HOST="127.0.0.1"
PORT="8081"

# 确保 server 目录存在（用于 pid / log）
mkdir -p server

# ---------- 从 server.conf 提取端口 ----------
if [ -f "$CONF" ]; then
    _port=$(grep -E '^\s*server\.socket_port' "$CONF" | head -n1 | awk -F'=' '{print $2}' | tr -d ' "')
    [ -n "$_port" ] && PORT="$_port"
fi

# ---------- 参数解析 ----------
ACTION="run"
DAEMON=0
args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
    arg="${args[$i]}"
    case "$arg" in
        -d|--daemon)     DAEMON=1 ;;
        --stop)          ACTION="stop" ;;
        --status)        ACTION="status" ;;
        --env)
            i=$((i+1))
            ENV_NAME="${args[$i]}"
            ;;
        -h|--help)
            print_help
            exit 0
            ;;
        *) log_warn "未知参数: $arg" ;;
    esac
    i=$((i+1))
done

# ---------- 停止 / 状态 ----------
if [ "$ACTION" = "stop" ]; then
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            log_info "停止后台进程 PID=$PID ..."
            kill "$PID"
            sleep 1
            kill -0 "$PID" 2>/dev/null && { log_warn "进程仍在，强制 kill -9"; kill -9 "$PID"; }
            log_ok "已停止"
        else
            log_warn "PID=$PID 已不存在"
        fi
        rm -f "$PID_FILE"
    else
        log_warn "未发现 $PID_FILE，可能未通过本脚本后台启动"
    fi
    exit 0
fi

if [ "$ACTION" = "status" ]; then
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log_ok "服务运行中，PID=$(cat "$PID_FILE")，地址: http://${HOST}:${PORT}"
    else
        log_warn "服务未在后台运行"
    fi
    exit 0
fi

# ---------- 定位 conda ----------
locate_conda() {
    if command -v conda &>/dev/null; then
        return 0
    fi
    for cand in "$HOME/anaconda3" "$HOME/miniconda3" "/opt/anaconda3" "/opt/miniconda3"; do
        if [ -x "$cand/bin/conda" ]; then
            export PATH="$cand/bin:$PATH"
            return 0
        fi
    done
    return 1
}

if ! locate_conda; then
    log_error "未检测到 conda。请先安装 Anaconda/Miniconda 再运行 start.sh"
    exit 1
fi
CONDA_ROOT="$(dirname "$(dirname "$(command -v conda)")")"
# shellcheck disable=SC1091
source "$CONDA_ROOT/etc/profile.d/conda.sh"

env_exists() {
    conda env list | awk '{print $1}' | grep -Fxq "$ENV_NAME"
}

if ! env_exists; then
    log_error "conda env '$ENV_NAME' 不存在。请先手动创建（例如复用 BEVFusion 项目的 bevfusion env），或用 --env 指定其他 env。"
    exit 1
fi

if [ ! -f "$MODEL_FILE" ]; then
    log_warn "找不到模型文件 $MODEL_FILE。/auto_annotate 会返回错误，直到把 ONNX 放到该路径。"
fi

# ---------- 激活 env ----------
conda activate "$ENV_NAME"
log_ok "已激活 conda env: $CONDA_PREFIX"

# 保险起见把 CUDA_HOME 指向当前 env（避免 base 的 CUDA 13 干扰）
if [ -x "$CONDA_PREFIX/bin/nvcc" ]; then
    export CUDA_HOME="$CONDA_PREFIX"
    export PATH="$CUDA_HOME/bin:$PATH"
    export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
fi

# ---------- 检查入口文件 ----------
if [ ! -f "$ENTRY" ]; then
    log_error "找不到入口文件 $ENTRY"
    exit 1
fi

mkdir -p temp data

# ---------- 端口占用检查 ----------
if command -v lsof &>/dev/null; then
    if lsof -iTCP:"$PORT" -sTCP:LISTEN &>/dev/null; then
        log_warn "端口 $PORT 已被占用，如是本脚本后台进程可先执行： bash start.sh --stop"
    fi
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log_error "检测到已在运行的后台进程 PID=$(cat "$PID_FILE")，请先执行： bash start.sh --stop"
    exit 1
fi

# ---------- 启动 ----------
log_info "启动服务 ..."
log_info "访问地址： ${C_BOLD}http://${HOST}:${PORT}${C_RESET}"

if [ "$DAEMON" = "1" ]; then
    nohup python "$ENTRY" >"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        log_ok "后台已启动，PID=$(cat "$PID_FILE")，日志： $LOG_FILE"
    else
        log_error "后台启动失败，请查看 $LOG_FILE"
        rm -f "$PID_FILE"
        exit 1
    fi
else
    exec python "$ENTRY"
fi
