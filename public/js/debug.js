// 极简 WebGL geometry 分配/释放计数器，用于开发时排查内存泄漏。
// 各 lidar/radar/annotation/... 模块在创建 THREE.BufferGeometry 时 alloc()，
// dispose 时 free()；线上运行影响可忽略。

class Debug {
    constructor() {
        this.allocated = 0;
        this.freed = 0;
    }

    alloc() {
        this.allocated++;
    }

    free() {
        this.freed++;
    }

    dump() {
        console.log(`[dbg] allocated=${this.allocated} freed=${this.freed} live=${this.allocated - this.freed}`);
    }
}

export { Debug };
