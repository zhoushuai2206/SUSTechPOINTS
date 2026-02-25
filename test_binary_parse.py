#!/usr/bin/env python3
"""
Test to verify binary PCD parsing matches the expected format
"""

def test_pcd_parsing(file_path):
    with open(file_path, 'rb') as f:
        # Read and parse header
        while True:
            line = f.readline().decode('ascii').strip()
            if line.startswith('DATA'):
                break

        # Now we're at the binary data
        data_start = f.tell()

        # Read first few points and show classify values
        print(f"Data starts at offset: {data_start}")
        print(f"\nFirst 5 points - raw bytes and parsed classify values:\n")

        row_size = 49  # Based on header calculation
        classify_offset = 48

        for i in range(5):
            row_start = data_start + i * row_size
            f.seek(row_start + classify_offset)
            classify_byte = f.read(1)
            classify_val = classify_byte[0] if classify_byte else 0

            # Also read a few bytes around classify for context
            f.seek(row_start + classify_offset - 2)
            context_bytes = f.read(5)

            print(f"Point {i}: classify = {classify_val} (context bytes: {context_bytes.hex()})")

        # Check if classify is consistently at the right place
        print(f"\nVerifying classify field position...")
        f.seek(data_start + classify_offset)

        # Read 20 classify values
        classify_values = []
        for i in range(20):
            f.seek(data_start + i * row_size + classify_offset)
            val = f.read(1)[0]
            classify_values.append(val)

        print(f"First 20 classify values: {classify_values}")

        # Also check if we're correctly skipping filtered points
        print(f"\nChecking for point filtering...")
        f.seek(data_start)

        valid_points = 0
        first_100_classify = []

        for i in range(100):
            row_start = data_start + i * row_size

            # Read x, y, z (first 12 bytes)
            f.seek(row_start)
            x_bytes = f.read(4)
            y_bytes = f.read(4)
            z_bytes = f.read(4)

            import struct
            x = struct.unpack('f', x_bytes)[0]
            y = struct.unpack('f', y_bytes)[0]
            z = struct.unpack('f', z_bytes)[0]

            # Check if point would be filtered
            filtered = (x == 0 and y == 0 and z == 0) or (x != x)  # NaN check

            # Read classify
            f.seek(row_start + classify_offset)
            classify_val = f.read(1)[0]

            if not filtered:
                valid_points += 1
                first_100_classify.append(classify_val)

            status = "FILTERED" if filtered else "VALID"
            if i < 10:  # Show first 10
                print(f"Point {i}: x={x:.2f}, y={y:.2f}, z={z:.2f}, classify={classify_val} [{status}]")

        print(f"\nOut of first 100 rows, {valid_points} are valid points")
        print(f"Classify values for valid points (first 20): {first_100_classify[:20]}")

if __name__ == '__main__':
    test_pcd_parsing('/home/gpal/Program/SUSTechPOINTS/data/example_classify/lidar/000970.pcd')
