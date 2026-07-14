// 前端标注辅助数学工具：插值/滤波与 yaw 预测代理。
// 移除了对 tensorflow.js 的所有直接依赖，只保留 SUSTechPOINTS 主流程真正用到的接口：
//   - ml.predict_rotation：调用后端 /predict_rotation（geometry-based L-shape）
//   - ml.interpolate_annotation：帧间标注插值 + moving-average 外推
//   - MaFilter：外推用的简单一阶滑动平均滤波器

import { logger } from "./log.js";

const annMath = {
    sub(a, b) {
        const c = [];
        for (const i in a) c[i] = a[i] - b[i];
        return this.norm(c);
    },
    div(a, d) {
        const c = [];
        for (const i in a) c[i] = a[i] / d;
        return c;
    },
    add(a, b) {
        const c = [];
        for (const i in a) c[i] = a[i] + b[i];
        return this.norm(c);
    },
    mul(a, d) {
        const c = [];
        for (const i in a) c[i] = a[i] * d;
        return this.norm(c);
    },
    norm(c) {
        // 3~5 位是 xyz 欧拉角，归一到 (-pi, pi]
        for (let i = 3; i < 6; i++) {
            if (c[i] > Math.PI) c[i] -= Math.PI * 2;
            else if (c[i] < -Math.PI) c[i] += Math.PI * 2;
        }
        return c;
    },
    normAngle(a) {
        if (a > Math.PI) return a - Math.PI * 2;
        if (a < -Math.PI) return a + Math.PI * 2;
        return a;
    },
    eleMul(a, b) {
        const c = [];
        for (const i in a) c[i] = a[i] * b[i];
        return c;
    },
};

const ml = {
    // 请求后端做 yaw 预测。data 是形如 [[x,y,z], ...] 的点集。
    predict_rotation(data) {
        const req = new Request("/predict_rotation");
        const init = {
            method: "POST",
            body: JSON.stringify({ points: data }),
        };
        console.log("start predict rotation.", data.length, "points");
        return fetch(req, init)
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                console.log("predict rotation response received.");
                return response.json();
            })
            .catch(() => {
                console.log("error predicting yaw angle!");
            });
    },

    // 对一段稀疏关键帧做插值 + 前后外推。autoAdj 是可选的每帧微调回调（异步）。
    async interpolate_annotation(anns, autoAdj, onFinishOneBox) {
        let i = 0;
        while (true) {
            while (i + 1 < anns.length && !(anns[i] && !anns[i + 1])) i++;

            const start = i;
            i += 2;
            while (i < anns.length && !anns[i]) i++;

            if (i < anns.length) {
                const end = i;
                let step = annMath.div(annMath.sub(anns[end], anns[start]), end - start);
                for (let inserti = start + 1; inserti < end; inserti++) {
                    let tempAnn = annMath.add(anns[inserti - 1], step);
                    if (autoAdj) {
                        try {
                            const adjustedAnn = await autoAdj(inserti, tempAnn);
                            const adjustedYaw = annMath.normAngle(adjustedAnn[5] - tempAnn[5]);
                            if (Math.abs(adjustedYaw) > Math.PI / 2) {
                                adjustedAnn[5] = annMath.normAngle(adjustedAnn[5] + Math.PI);
                            }
                            if (!pointsGlobalConfig.enableAutoRotateXY) {
                                adjustedAnn[3] = 0;
                                adjustedAnn[4] = 0;
                            }
                            tempAnn = adjustedAnn;
                        } catch (e) {
                            console.log(e);
                        }
                    }
                    anns[inserti] = tempAnn;
                    step = annMath.div(annMath.sub(anns[end], anns[inserti]), end - inserti);
                    if (onFinishOneBox) onFinishOneBox(inserti);
                }
            } else {
                break;
            }
        }

        // forward 外推
        i = 0;
        while (i < anns.length && !anns[i]) i++;
        if (i < anns.length) {
            const filter = new MaFilter(anns[i]);
            i++;
            while (i < anns.length && anns[i]) {
                filter.update(anns[i]);
                i++;
            }
            while (i < anns.length && !anns[i]) {
                let tempAnn = filter.predict();
                if (autoAdj) {
                    try {
                        const adjustedAnn = await autoAdj(i, tempAnn);
                        const adjustedYaw = annMath.normAngle(adjustedAnn[5] - tempAnn[5]);
                        if (Math.abs(adjustedYaw) > Math.PI / 2) {
                            adjustedAnn[5] = annMath.normAngle(adjustedAnn[5] + Math.PI);
                        }
                        tempAnn = adjustedAnn;
                        filter.update(tempAnn);
                    } catch (error) {
                        console.log(error);
                        filter.nextStep(tempAnn);
                    }
                } else {
                    filter.nextStep(tempAnn);
                }
                anns[i] = tempAnn;
                if (onFinishOneBox) onFinishOneBox(i);
                i++;
            }
        }

        // backward 外推
        i = anns.length - 1;
        while (i >= 0 && !anns[i]) i--;
        if (i >= 0) {
            const filter = new MaFilter(anns[i]);
            i--;
            while (i >= 0 && anns[i]) {
                filter.update(anns[i]);
                i--;
            }
            while (i >= 0 && !anns[i]) {
                let tempAnn = filter.predict();
                if (autoAdj) {
                    const adjustedAnn = await autoAdj(i, tempAnn).catch((e) => {
                        logger.log(e);
                        return tempAnn;
                    });
                    const adjustedYaw = annMath.normAngle(adjustedAnn[5] - tempAnn[5]);
                    if (Math.abs(adjustedYaw) > Math.PI / 2) {
                        adjustedAnn[5] = annMath.normAngle(adjustedAnn[5] + Math.PI);
                    }
                    tempAnn = adjustedAnn;
                    filter.update(tempAnn);
                } else {
                    filter.nextStep(tempAnn);
                }
                anns[i] = tempAnn;
                if (onFinishOneBox) onFinishOneBox(i);
                i--;
            }
        }

        return anns;
    },
};


function MaFilter(initX) {
    this.x = initX;
    this.step = 0;
    this.v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.ones = [1, 1, 1, 1, 1, 1, 1, 1, 1];
    this.decay = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

    this.update = function (x) {
        if (this.step == 0) {
            this.v = annMath.sub(x, this.x);
        } else {
            this.v = annMath.add(
                annMath.eleMul(annMath.sub(x, this.x), this.decay),
                annMath.eleMul(this.v, annMath.sub(this.ones, this.decay))
            );
        }
        this.x = x;
        this.step++;
    };

    this.predict = function () {
        return [...annMath.add(this.x, this.v).slice(0, 6), ...this.x.slice(6)];
    };

    this.nextStep = function (x) {
        this.x = x;
        this.step++;
    };
}

export { ml, MaFilter };
