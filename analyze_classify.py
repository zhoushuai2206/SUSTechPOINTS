#!/usr/bin/env python3
"""
分析PCD文件中Classify字段的取值分布
"""
import struct
from collections import Counter

# PCD文件路径
pcd_path = "/home/gpal/Program/SUSTechPOINTS/data/example/lidar/1751866038.675474.pcd"

# 读取文件头部
with open(pcd_path, 'rb') as f:
    header_lines = []
    while True:
        line = f.readline().decode('ascii').strip()
        header_lines.append(line)
        if line == "DATA binary":
            break

    print("=== 文件头部信息 ===")
    for line in header_lines:
        print(line)
    print()

    # 数据格式: x(4F) y(4F) z(4F) intensity(2U) timestamp_offset(4F) ring(2U) classify(2U)
    # 总共 4+4+4+2+4+2+2 = 22 字节每点

    # 读取二进制数据
    data = f.read()

print(f"\n=== 数据信息 ===")
print(f"总字节数: {len(data)}")
print(f"每点字节数: 22")
print(f"点数: {len(data) // 22}")

# 解析Classify字段 (最后一个字段，2字节无符号整数)
classify_values = []
point_size = 22
classify_offset = 20  # classify是第7个字段，从前6个字段偏移

num_points = len(data) // point_size
for i in range(num_points):
    offset = i * point_size + classify_offset
    # 读取2字节无符号整数 (小端序)
    classify = struct.unpack_from('<H', data, offset)[0]
    classify_values.append(classify)

# 统计Classify字段取值分布
classify_counter = Counter(classify_values)

print(f"\n=== Classify字段统计 ===")
print(f"唯一取值数量: {len(classify_counter)}")
print()

print("=== 各取值的点数统计 (按值排序) ===")
total = len(classify_values)
for val in sorted(classify_counter.keys()):
    count = classify_counter[val]
    percentage = (count / total) * 100
    print(f"Classify = {val:4d}: {count:7d} 个点 ({percentage:6.2f}%)")

print()
print("=== 各取值的点数统计 (按点数降序) ===")
for val, count in classify_counter.most_common():
    percentage = (count / total) * 100
    print(f"Classify = {val:4d}: {count:7d} 个点 ({percentage:6.2f}%)")
