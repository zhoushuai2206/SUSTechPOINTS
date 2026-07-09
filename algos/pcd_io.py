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


if __name__ == '__main__':
    import sys
    p, f = read_pcd(sys.argv[1])
    print("shape:", p.shape, "fields:", f)
    print(p[:3])
