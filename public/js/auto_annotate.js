function autoAnnotate(world, done, alg){
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () {
        if (this.readyState != 4) return;

        if (this.status == 200) {
            let anns;
            try {
                anns = JSON.parse(this.responseText);
            } catch (e) {
                console.error("[auto-annotate] invalid response", e, this.responseText);
                return;
            }
            if (!Array.isArray(anns)) {
                console.error("[auto-annotate] unexpected response", anns);
                return;
            }

            // 模型是只包含 car 类别的 lidar-only 模型。不要再按尺寸猜类别：
            // 小尺寸的 Car 候选框会被误改成 Motorcycle/Bicycle，且保存后污染 label。
            // 以后模型支持多类别时，直接沿用后端返回的 obj_type。
            world.annotation.reapplyAnnotation(anns, () => {
                if (done) done();
            });
        } else {
            console.error(`[auto-annotate] HTTP ${this.status}`, this.responseText);
        }
    };

    xhr.open('GET', "/auto_annotate?"+"scene="+world.frameInfo.scene+"&frame="+world.frameInfo.frame, true);
    xhr.send();
}


// 触发整个 clip 的自动标注：由服务器串行推理并落盘 label/*.json，
// 完成后前端把已加载帧的标注从磁盘重新拉一遍即可看到新结果。
function autoAnnotateScene(scene, done, onError){
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function () {
        if (this.readyState != 4) return;
        if (this.status == 200) {
            let payload = null;
            try { payload = JSON.parse(this.responseText); } catch(_e) { payload = null; }
            if (done) done(payload);
        } else if (onError) {
            onError(this.status, this.responseText);
        }
    };
    xhr.open('GET', "/auto_annotate_scene?scene=" + encodeURIComponent(scene) + "&save=1", true);
    xhr.send();
}


export {autoAnnotate, autoAnnotateScene}