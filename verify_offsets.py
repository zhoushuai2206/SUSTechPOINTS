#!/usr/bin/env python3
"""
Verify PCD field offset calculation
"""

def verify_offsets(file_path):
    with open(file_path, 'rb') as f:
        # Read and parse header
        while True:
            line = f.readline().decode('ascii').strip()
            if line.startswith('DATA'):
                break

        # Parse header fields
        fields = ['x', 'y', 'z', '_', 'intensity', '_', 'timestamp', '_', 'ring', '_', 'classify']
        sizes = [4, 4, 4, 1, 4, 1, 8, 1, 2, 1, 1]
        counts = [1, 1, 1, 4, 1, 0, 1, 6, 1, 12, 1]
        types = ['F', 'F', 'F', 'U', 'F', 'U', 'F', 'U', 'U', 'U', 'U']

        # Calculate offsets (same as PCDLoader.js)
        offset = {}
        sizeSum = 0
        for i, field in enumerate(fields):
            offset[field] = sizeSum
            sizeSum += sizes[i] * counts[i]

        rowSize = sizeSum

        print(f"Row size: {rowSize} bytes")
        print("\nField offsets:")
        for field in fields:
            print(f"  {field:12s}: offset={offset[field]:3d}, size={sizes[fields.index(field)]}, count={counts[fields.index(field)]}")

        # Verify classify offset
        classify_offset = offset['classify']
        print(f"\nClassify field offset: {classify_offset} bytes")

        # Read first few points and verify classify values
        data_start = f.tell()
        print(f"\nData starts at: {data_start}")

        print("\nFirst 10 points - detailed analysis:")
        for i in range(10):
            row_start = data_start + i * rowSize

            # Read x, y, z
            f.seek(row_start + offset['x'])
            x_bytes = f.read(4)
            import struct
            x = struct.unpack('f', x_bytes)[0]

            f.seek(row_start + offset['y'])
            y = struct.unpack('f', f.read(4))[0]

            f.seek(row_start + offset['z'])
            z = struct.unpack('f', f.read(4))[0]

            # Read intensity
            f.seek(row_start + offset['intensity'])
            intensity = struct.unpack('f', f.read(4))[0]

            # Read classify
            f.seek(row_start + classify_offset)
            classify = struct.unpack('B', f.read(1))[0]

            # Check if point would be filtered
            filtered = (x == 0 and y == 0 and z == 0) or (x != x)  # NaN check

            print(f"  Point {i}: x={x:7.2f}, y={y:7.2f}, z={z:7.2f}, intensity={intensity:.2f}, classify={classify:2d} {'[FILTERED]' if filtered else ''}")

        # Read 100 classify values directly
        print("\nDirect read of first 100 classify values:")
        f.seek(data_start + classify_offset)
        classify_values = []
        for i in range(100):
            f.seek(data_start + i * rowSize + classify_offset)
            val = struct.unpack('B', f.read(1))[0]
            classify_values.append(val)

        print(f"  {classify_values}")

        # Count unique values in first 1000
        f.seek(data_start + classify_offset)
        from collections import Counter
        all_classify = []
        for i in range(1000):
            f.seek(data_start + i * rowSize + classify_offset)
            val = struct.unpack('B', f.read(1))[0]
            all_classify.append(val)

        counts = Counter(all_classify)
        print(f"\nClassify value distribution (first 1000 points):")
        for val in sorted(counts.keys()):
            print(f"  Value {val}: {counts[val]} points")

if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:
        verify_offsets(sys.argv[1])
    else:
        # Test all files
        files = [
            '/home/gpal/Program/SUSTechPOINTS/data/example_classify/lidar/000965.pcd',
            '/home/gpal/Program/SUSTechPOINTS/data/example_classify/lidar/000970.pcd',
            '/home/gpal/Program/SUSTechPOINTS/data/example_classify/lidar/000975.pcd',
        ]
        for f in files:
            print("=" * 70)
            print(f"FILE: {f.split('/')[-1]}")
            print("=" * 70)
            verify_offsets(f)
            print()
