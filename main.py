"""SUSTechPOINTS 主入口。只保留 CCRS 数据支持相关的 endpoint。"""

import json
import os
import sys

# 把 CWD 切到本文件所在目录，让 server.conf / algos/detector_config.json /
# tools/scene_reader.py 里所有相对路径（`./data`、`./public` 等）都以项目根为准，
# 避免用户从别的目录运行 `python /path/to/main.py` 时找不到文件。
_PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(_PROJECT_ROOT)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

import cherrypy
from jinja2 import Environment, FileSystemLoader

from algos import pre_annotate
from tools import check_labels as check
from tools import scene_reader

env = Environment(loader=FileSystemLoader(_PROJECT_ROOT))


def _set_no_cache_headers():
    """禁止浏览器缓存静态资源/接口响应，避免前端拿到旧 JS 造成路径不一致。"""
    cherrypy.response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    cherrypy.response.headers['Pragma'] = 'no-cache'
    cherrypy.response.headers['Expires'] = '0'


cherrypy.tools.no_cache = cherrypy.Tool('before_finalize', _set_no_cache_headers)


class Root:
    @cherrypy.expose
    def index(self, scene="", frame=""):
        tmpl = env.get_template('index.html')
        return tmpl.render()

    @cherrypy.expose
    def saveworldlist(self):
        # 读取完整请求体：readline() 遇到换行会截断，read() 才能拿到全部 JSON
        rawbody = cherrypy.request.body.read().decode('UTF-8')
        try:
            data = json.loads(rawbody)
        except Exception as e:
            cherrypy.response.status = 400
            print(f"[main] saveworldlist invalid json: {e}")
            return "invalid json"

        try:
            for d in data:
                scene = d["scene"]
                frame = d["frame"]
                ann = d["annotation"]
                label_dir = os.path.join("./data", scene, "label")
                # CCRS clip 里 label 子目录可能不存在，按需创建
                os.makedirs(label_dir, exist_ok=True)
                filename = os.path.join(label_dir, frame + ".json")
                with open(filename, 'w') as f:
                    json.dump(ann, f, indent=2, sort_keys=True)
        except Exception as e:
            cherrypy.response.status = 500
            print(f"[main] saveworldlist error: {e}")
            return f"save failed: {e}"

        return "ok"

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def checkscene(self, scene):
        ck = check.LabelChecker(os.path.join("./data", scene))
        ck.check()
        print(ck.messages)
        return ck.messages

    # data: N*3 numpy array
    @cherrypy.expose
    @cherrypy.tools.json_out()
    def predict_rotation(self):
        rawbody = cherrypy.request.body.readline().decode('UTF-8')
        try:
            data = json.loads(rawbody)
        except Exception:
            cherrypy.response.status = 400
            return {"error": "invalid json"}
        pts = data.get("points") if isinstance(data, dict) else None
        if pts is None:
            cherrypy.response.status = 400
            return {"error": "field 'points' missing"}
        return {"angle": pre_annotate.predict_yaw(pts)}

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def ml_status(self):
        """探查当前半自动标注后端加载状态，方便前端/运维排查。"""
        return pre_annotate.get_status()

    def _resolve_pcd_path(self, scene, frame):
        """按 scene_reader 报告的 lidar 目录/后缀拼装 pcd 文件路径。"""
        meta = scene_reader.get_one_scene(scene) or {}
        lidar_dir = meta.get("lidar_dir") or "lidar_center"
        lidar_ext = meta.get("lidar_ext") or ".pcd"
        return os.path.join("./data", scene, lidar_dir, frame + lidar_ext)

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def auto_annotate(self, scene, frame):
        print("auto annotate", scene, frame)
        pcd_path = self._resolve_pcd_path(scene, frame)
        if not os.path.isfile(pcd_path):
            cherrypy.response.status = 404
            return {"error": f"pcd not found: {pcd_path}"}
        try:
            return pre_annotate.annotate_file(pcd_path)
        except Exception as e:
            cherrypy.response.status = 500
            # 详细错误只在服务器日志里，返回给前端的是简明信息
            print(f"[main] auto_annotate error: {e}")
            return {"error": f"auto_annotate failed: {e}"}

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def load_annotation(self, scene, frame):
        return scene_reader.read_annotations(scene, frame)

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def load_ego_pose(self, scene, frame):
        return scene_reader.read_ego_pose(scene, frame)

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def loadworldlist(self):
        rawbody = cherrypy.request.body.readline().decode('UTF-8')
        worldlist = json.loads(rawbody)
        return [{
            "scene": w["scene"],
            "frame": w["frame"],
            "annotation": scene_reader.read_annotations(w["scene"], w["frame"]),
        } for w in worldlist]

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def datameta(self):
        return scene_reader.get_all_scenes()

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def scenemeta(self, scene):
        return scene_reader.get_one_scene(scene)

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def get_all_scene_desc(self):
        return scene_reader.get_all_scene_desc()

    @cherrypy.expose
    @cherrypy.tools.json_out()
    def objs_of_scene(self, scene):
        return self.get_all_objs(os.path.join("./data", scene))

    def get_all_objs(self, path):
        label_folder = os.path.join(path, "label")
        if not os.path.isdir(label_folder):
            return []

        files = [f for f in os.listdir(label_folder) if f.split(".")[-1] == "json"]

        def file_2_objs(f):
            with open(f) as fd:
                boxes = json.load(fd)
                return [{"category": b["obj_type"], "id": b["obj_id"]} for b in boxes]

        # {category-id : {category, id, count}}
        all_objs = {}
        for f in files:
            for o in file_2_objs(os.path.join(label_folder, f)):
                k = f"{o['category']}-{o['id']}"
                if all_objs.get(k):
                    all_objs[k]['count'] += 1
                else:
                    all_objs[k] = {
                        "category": o["category"],
                        "id": o["id"],
                        "count": 1,
                    }

        return list(all_objs.values())


_SERVER_CONF = os.path.join(_PROJECT_ROOT, "server", "server.conf")

if __name__ == '__main__':
    cherrypy.quickstart(Root(), '/', config=_SERVER_CONF)
else:
    application = cherrypy.Application(Root(), '/', config=_SERVER_CONF)
