"""
最小 PCD 文件读取器（ASCII / 二进制未压缩），返回 numpy 数组。

不依赖 open3d / python-pcl，避免给标注服务引入重型依赖。
支持 PCD 头里的 padding 字段（FIELDS `_`，COUNT 0/N 组合），常见于
RSLidar / Livox 等实车雷达导出的点云。

输出：
    points: np.ndarray, shape (N, C), dtype=float32
    fields: list[str]，实际返回的字段名（对应列顺序）
"""

from __future__ import annotations

import numpy as np
from pathlib import Path


class PcdReadError(Exception):
    pass


_TYPE_MAP = {
    ('F', 4): 'f4', ('F', 8): 'f8',
    ('U', 1): 'u1', ('U', 2): 'u2', ('U', 4): 'u4', ('U', 8): 'u8',
    ('I', 1): 'i1', ('I', 2): 'i2', ('I', 4): 'i4', ('I', 8): 'i8',
}


def _parse_header(fp):
    header = {}
    while True:
        line = fp.readline()
        if not line:
            raise PcdReadError("unexpected EOF while parsing header")
        try:
            text = line.decode('ascii').strip()
        except UnicodeDecodeError:
            raise PcdReadError("non-ascii bytes in header")
        if not text or text.startswith('#'):
            continue
        parts = text.split()
        key = parts[0].upper()
        header[key] = parts[1:]
        if key == 'DATA':
            break
    return header


def _uniquify(names):
    """让字段名不重复：碰到 `_` 或已用过的名字，追加后缀。"""
    used = {}
    out = []
    for n in names:
        base = n if n not in ('_', '') else '_pad'
        if base not in used:
            used[base] = 0
            out.append(base)
        else:
            used[base] += 1
            out.append(f"{base}_{used[base]}")
    return out


def _build_layout(fields, sizes, types, counts):
    """按 PCD header 计算每个字段在一条 record 里的字节 offset 与 dtype。

    对 count=0 的字段直接跳过（不占字节）；对 count>1 的字段，dtype 变成
    (base, count) 的定长数组，读出来后再决定是否展开。
    """
    layout = []  # list of (name, sub_dtype, offset, count)
    offset = 0
    raw_names = _uniquify(fields)
    for name, size, tp, cnt in zip(raw_names, sizes, types, counts):
        size = int(size)
        cnt = int(cnt)
        key = (tp.upper(), size)
        if key not in _TYPE_MAP:
            raise PcdReadError(f"unsupported field type: {name} {tp}{size}")
        base = _TYPE_MAP[key]
        if cnt <= 0:
            # 明确表示"无数据"，不占字节；直接跳过
            continue
        if cnt == 1:
            sub = np.dtype(base)
        else:
            sub = np.dtype((base, (cnt,)))
        layout.append((name, sub, offset, cnt))
        offset += sub.itemsize
    return layout, offset


def read_pcd(path, want_fields=('x', 'y', 'z', 'intensity')) -> tuple[np.ndarray, list[str]]:
    """读取 PCD 文件，返回 (points, actual_fields)。

    points 是 (N, len(actual_fields)) 的 float32 数组，列顺序对应 want_fields。
    缺失字段（如没有 intensity）会填 0。
    """
    path = Path(path)
    if not path.is_file():
        raise PcdReadError(f"file not found: {path}")

    with open(path, 'rb') as fp:
        header = _parse_header(fp)
        data_mode = (header.get('DATA', ['ascii'])[0]).lower()
        fields = header.get('FIELDS', [])
        sizes = header.get('SIZE', [])
        types = header.get('TYPE', [])
        counts = header.get('COUNT', ['1'] * len(fields))
        points_num = int(header.get('POINTS', ['0'])[0])

        if not fields:
            raise PcdReadError("FIELDS missing in header")
        if len(sizes) != len(fields) or len(types) != len(fields):
            raise PcdReadError("SIZE/TYPE mismatch FIELDS")

        layout, record_size = _build_layout(fields, sizes, types, counts)
        if record_size == 0:
            raise PcdReadError("all fields have count=0, nothing to read")

        # 用 offsets 构造 structured dtype，即使有 padding 也不会重叠
        names = [n for n, _, _, _ in layout]
        formats = [d for _, d, _, _ in layout]
        offsets = [o for _, _, o, _ in layout]
        dtype = np.dtype({
            'names': names,
            'formats': formats,
            'offsets': offsets,
            'itemsize': record_size,
        })

        if data_mode == 'binary':
            buf = fp.read(points_num * record_size)
            if len(buf) < points_num * record_size:
                raise PcdReadError("binary data truncated")
            arr = np.frombuffer(buf, dtype=dtype, count=points_num)
        elif data_mode == 'ascii':
            # ASCII 里没有 padding 字段（count=0 的 field 完全不出现在数据里），
            # 直接按 (points_num, sum(count)) 展平读，再按 layout 切出各字段。
            tokens = fp.read().decode('ascii').split()
            total_cols = sum(c for _, _, _, c in layout)
            expected = points_num * total_cols
            if len(tokens) < expected:
                raise PcdReadError(f"ascii data too short: {len(tokens)} < {expected}")
            flat = np.asarray(tokens[:expected], dtype=np.float64).reshape(points_num, total_cols)
            arr = np.empty(points_num, dtype=dtype)
            col = 0
            for (name, sub, _off, cnt) in layout:
                slice_ = flat[:, col:col + cnt]
                if cnt == 1:
                    arr[name] = slice_[:, 0].astype(sub)
                else:
                    arr[name] = slice_.astype(sub.base)
                col += cnt
        else:
            raise PcdReadError(f"unsupported DATA mode: {data_mode} "
                               "(binary_compressed 请先转换为 ascii/binary)")

    # 按 want_fields 组装 (N, C)
    cols = []
    actual = []
    n = arr.shape[0]
    for f in want_fields:
        if f in arr.dtype.names:
            v = arr[f]
            if v.ndim > 1:
                # 多分量字段只取第一分量，避免 shape 冲突（比如 RGB 打包在一起时）
                v = v[:, 0]
            cols.append(np.asarray(v, dtype=np.float32).reshape(n, 1))
            actual.append(f)
        else:
            cols.append(np.zeros((n, 1), dtype=np.float32))
            actual.append(f)
    return np.concatenate(cols, axis=1).astype(np.float32, copy=False), actual


def write_pcd_with_classify(path, classify, out_path=None):
    """把 `classify` (uint8) 值写回 PCD 文件。

    本项目的所有 PCD 都带有 `classify` 字段（TYPE U / SIZE 1 / COUNT 1）且为
    `DATA binary`，因此这里做的是**原地字节改写**：header 原文一字节不动，
    只把每条 record 里 classify 所在的那 1 个字节替换掉。这样 x/y/z/intensity
    等字段的原始字节完全保留，不存在任何精度损失，也不会因为重建 header 而
    丢掉 VIEWPOINT 之类的原始信息。

    若文件不满足上述前提（非 binary、没有 classify 字段、classify 不是 U1），
    直接抛错，而不是退化成重编码路径 —— 静默改写文件格式比失败更危险。

    参数:
        path: 原始 PCD 路径。
        classify: 长度为 POINTS 的一维数组/列表，元素取值 0-255。
        out_path: 输出路径。默认原地覆盖 (path)。

    返回: 实际写入的路径 (str)。
    """
    path = Path(path)
    if not path.is_file():
        raise PcdReadError(f"file not found: {path}")

    classify = np.asarray(classify, dtype=np.uint8).reshape(-1)

    with open(path, 'rb') as fp:
        # 逐行读 header，读到 DATA 行为止；此时 fp 正好停在数据段开头。
        header_lines = []
        while True:
            line = fp.readline()
            if not line:
                raise PcdReadError("unexpected EOF while parsing header")
            header_lines.append(line)
            if line.decode('ascii', errors='replace').strip().upper().startswith('DATA'):
                break
        header_bytes = b''.join(header_lines)
        data_bytes = fp.read()

    header = {}
    for raw in header_lines:
        text = raw.decode('ascii', errors='replace').strip()
        if not text or text.startswith('#'):
            continue
        parts = text.split()
        header[parts[0].upper()] = parts[1:]

    data_mode = header.get('DATA', ['ascii'])[0].lower()
    if data_mode != 'binary':
        raise PcdReadError(
            f"only 'DATA binary' is supported for classify write, got '{data_mode}': {path}")

    fields = list(header.get('FIELDS', []))
    sizes = list(header.get('SIZE', []))
    types = list(header.get('TYPE', []))
    counts = list(header.get('COUNT', ['1'] * len(fields)))
    if 'classify' not in fields:
        raise PcdReadError(f"no 'classify' field in header: {path}")
    idx = fields.index('classify')
    if (types[idx].upper(), int(sizes[idx]), int(counts[idx])) != ('U', 1, 1):
        raise PcdReadError(
            f"'classify' must be TYPE U / SIZE 1 / COUNT 1, got "
            f"{types[idx]}{sizes[idx]} count={counts[idx]}: {path}")

    points_num = int(header.get('POINTS', header.get('WIDTH', ['0']))[0])
    if classify.size != points_num:
        raise PcdReadError(f"classify length {classify.size} != POINTS {points_num}")

    layout, record_size = _build_layout(fields, sizes, types, counts)
    classify_offset = next(off for name, _sub, off, _cnt in layout if name == 'classify')

    expected = points_num * record_size
    if len(data_bytes) < expected:
        raise PcdReadError(
            f"binary data truncated: need {expected} bytes, got {len(data_bytes)}: {path}")

    # 只改 classify 那一列，其余字节（含 expected 之后的尾部填充）原样保留。
    buf = bytearray(data_bytes)
    view = np.frombuffer(buf, dtype=np.uint8, count=expected).reshape(points_num, record_size)
    view[:, classify_offset] = classify

    target = Path(out_path) if out_path else path
    with open(target, 'wb') as fp:
        fp.write(header_bytes)
        fp.write(buf)
    return str(target)


if __name__ == '__main__':
    import sys
    p, f = read_pcd(sys.argv[1])
    print("shape:", p.shape, "fields:", f)
    print(p[:3])
