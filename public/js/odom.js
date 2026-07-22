// odom.js
// Scene 级别的 odom 位姿管理。每个 scene 的 odom 数据只从后端加载一次，之后
// 通过 frame id 里的时间戳到 odom 时间序列上做线性插值，得到该 frame 对应
// 的 ego 在 odom（世界）系下的位姿。
//
// frame id 命名约定：`"<sec>_<nsec>"`，两段拼接得到 nanoseconds；这与后端
// odom.csv 里的 header_t_ns 同源。lidar 点云和 3D 框都定义在 ego 系。
//
// 由 editor.js 在跨帧粘贴时使用：先算出源帧和目标帧的 ego 位姿差 (T_src->tgt
// = T_ego_tgt^-1 · T_ego_src)，把源帧的 box (在 ego_src 系下) 变到目标帧
// (ego_tgt 系) 得到粘贴后的初始位置/朝向。


// --- module-level state ---
// { [sceneName]: { promise, poses: [{t_ns:BigInt, x, y, z, yaw}, ...] | null } }
const _odomCache = {};


// 把 "sec_nsec" 形式的 frame id 转成纳秒的 BigInt。做成 BigInt 是因为 header_t_ns
// 已经超过 2^53，直接用 Number 会丢精度、插值会跳。
function frameIdToNs(frame) {
    if (typeof frame !== "string") return null;

    // 常见形式 "109540_198653216"（sec_nsec）
    const parts = frame.split("_");
    if (parts.length === 2) {
        const sec = parts[0];
        const nsec = parts[1];
        if (/^\d+$/.test(sec) && /^\d+$/.test(nsec)) {
            // header_t_ns = sec * 1e9 + nsec
            return BigInt(sec) * 1000000000n + BigInt(nsec);
        }
    }

    // 兜底：如果 frame 就是一个纯数字（纳秒），也接受
    if (/^\d+$/.test(frame)) {
        return BigInt(frame);
    }
    return null;
}


// 二分查找：在按 t_ns 升序排列的 poses 中，返回最后一个 t_ns <= t 的下标；
// 若 t 小于所有元素返回 -1。
function _bisectRight(poses, t) {
    let lo = 0, hi = poses.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (poses[mid].t_ns <= t) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo - 1;
}


// 归一化到 (-pi, pi]，避免线性插值跨过 ±pi 时算出反方向的 yaw。
function _wrapAngle(a) {
    const TAU = Math.PI * 2;
    let x = ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
    return x;
}


function _lerpYaw(y0, y1, r) {
    // 走最短弧
    let dy = _wrapAngle(y1 - y0);
    return _wrapAngle(y0 + dy * r);
}


class OdomManager {
    // 拉取并缓存整个 scene 的 odom 序列。返回 Promise<poses|null>。
    static loadScene(scene) {
        if (_odomCache[scene] && _odomCache[scene].promise) {
            return _odomCache[scene].promise;
        }

        const entry = { poses: null };
        entry.promise = new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.onreadystatechange = function () {
                if (this.readyState !== 4) return;
                if (this.status === 200) {
                    try {
                        const raw = JSON.parse(this.responseText);
                        if (Array.isArray(raw) && raw.length > 0) {
                            // 把 t_ns 从字符串（或 number）统一转成 BigInt，
                            // 避免 JS Number 精度问题
                            entry.poses = raw.map(p => ({
                                t_ns: BigInt(p.t_ns),
                                x: p.x,
                                y: p.y,
                                z: p.z,
                                yaw: p.yaw,
                            }));
                        } else {
                            entry.poses = null;
                        }
                    } catch (e) {
                        console.warn("[odom] parse failed", e);
                        entry.poses = null;
                    }
                } else {
                    entry.poses = null;
                }
                resolve(entry.poses);
            };
            xhr.open("GET", "/load_odom?scene=" + encodeURIComponent(scene), true);
            xhr.send();
        });

        _odomCache[scene] = entry;
        return entry.promise;
    }

    // 同步取得该 scene 的 poses（要求已经 loadScene 完成）。没有则返回 null。
    static getPoses(scene) {
        const c = _odomCache[scene];
        return c ? c.poses : null;
    }

    // 在 poses 上按时间戳插值，返回 {x, y, z, yaw}。找不到位姿或 poses 为空时返回 null。
    static interpolatePose(poses, t_ns) {
        if (!poses || poses.length === 0 || t_ns === null || t_ns === undefined) {
            return null;
        }

        // 边界：小于第一个 -> 用第一个；大于最后一个 -> 用最后一个。
        if (t_ns <= poses[0].t_ns) {
            const p = poses[0];
            return { x: p.x, y: p.y, z: p.z, yaw: p.yaw };
        }
        if (t_ns >= poses[poses.length - 1].t_ns) {
            const p = poses[poses.length - 1];
            return { x: p.x, y: p.y, z: p.z, yaw: p.yaw };
        }

        const i = _bisectRight(poses, t_ns);
        const p0 = poses[i];
        const p1 = poses[i + 1];

        // BigInt 相减再转 Number；两段时间差最多 ~1s 级别，Number 足够。
        const dt = Number(p1.t_ns - p0.t_ns);
        if (dt === 0) {
            return { x: p0.x, y: p0.y, z: p0.z, yaw: p0.yaw };
        }
        const r = Number(t_ns - p0.t_ns) / dt;

        return {
            x: p0.x + (p1.x - p0.x) * r,
            y: p0.y + (p1.y - p0.y) * r,
            z: p0.z + (p1.z - p0.z) * r,
            yaw: _lerpYaw(p0.yaw, p1.yaw, r),
        };
    }

    // 便捷接口：给 (scene, frame) 直接返回该帧的 ego 位姿。scene 必须先 loadScene 过。
    static getPoseForFrame(scene, frame) {
        const poses = OdomManager.getPoses(scene);
        if (!poses) return null;
        const t = frameIdToNs(frame);
        if (t === null) return null;
        return OdomManager.interpolatePose(poses, t);
    }

    // 计算从 srcPose(ego_src -> odom) 到 tgtPose(ego_tgt -> odom) 的相对变换，
    // 用于把 ego_src 系下的点/框搬到 ego_tgt 系下。
    //
    // 数学推导：
    //   世界点 P_w = T_odom<-src · P_src        (P_src 是 box 在源帧 ego 系下的位置)
    //   目标帧下的点 P_tgt = T_tgt<-odom · P_w = T_odom<-tgt^-1 · T_odom<-src · P_src
    //
    // 我们只关心平面（x,y,yaw），z 直接沿用 src。返回一个 {applyPosition, applyYaw}
    // 闭包，方便逐个 box 应用。
    static makeTransformer(srcPose, tgtPose) {
        if (!srcPose || !tgtPose) return null;

        const cSrc = Math.cos(srcPose.yaw);
        const sSrc = Math.sin(srcPose.yaw);
        const cTgt = Math.cos(tgtPose.yaw);
        const sTgt = Math.sin(tgtPose.yaw);

        // T_odom<-src · p_src： R_src * p + t_src
        // 然后再左乘 T_odom<-tgt^-1： R_tgt^T * (q - t_tgt)
        // 展开合并，等价一次 2D 刚体变换。
        const dyaw = _wrapAngle(srcPose.yaw - tgtPose.yaw);

        // translation：把 (t_src - t_tgt) 变到 tgt 系
        const dx_w = srcPose.x - tgtPose.x;
        const dy_w = srcPose.y - tgtPose.y;
        // 逆旋转 R_tgt^T
        const tx = cTgt * dx_w + sTgt * dy_w;
        const ty = -sTgt * dx_w + cTgt * dy_w;
        const tz = (srcPose.z - tgtPose.z);

        const cD = Math.cos(dyaw);
        const sD = Math.sin(dyaw);

        return {
            // 平面变换：把 src ego 系下的 (x,y) 变成 tgt ego 系下的 (x,y)
            // p_tgt = R(dyaw) * p_src + t
            applyPosition(pos) {
                const x = cD * pos.x - sD * pos.y + tx;
                const y = sD * pos.x + cD * pos.y + ty;
                const z = pos.z + tz;
                return { x, y, z };
            },
            // yaw：绕 z 轴的朝向变换
            applyYawZ(yawZ) {
                return _wrapAngle(yawZ + dyaw);
            },
            dyaw,
            translation: { x: tx, y: ty, z: tz },
        };
    }
}


export { OdomManager, frameIdToNs };
