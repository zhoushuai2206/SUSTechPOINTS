import random
import string

import cherrypy
import os
import json
from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader('./'))

import os
import sys
import scene_reader
from tools import check_labels  as check


# BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# sys.path.append(BASE_DIR)

#sys.path.append(os.path.join(BASE_DIR, './algos'))
#import algos.rotation as rotation
from algos import pre_annotate


#sys.path.append(os.path.join(BASE_DIR, '../tracking'))
#import algos.trajectory as trajectory

# extract_object_exe = "~/code/pcltest/build/extract_object"
# registration_exe = "~/code/go_icp_pcl/build/test_go_icp"

# sys.path.append(os.path.join(BASE_DIR, './tools'))
# import tools.dataset_preprocess.crop_scene as crop_scene

class Root(object):
    @cherrypy.expose
    def index(self, scene="", frame=""):
      cherrypy.response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
      cherrypy.response.headers['Pragma'] = 'no-cache'
      cherrypy.response.headers['Expires'] = '0'
      tmpl = env.get_template('index.html')
      return tmpl.render()
  
    @cherrypy.expose
    def icon(self):
      tmpl = env.get_template('test_icon.html')
      return tmpl.render()

    @cherrypy.expose
    def ml(self):
      tmpl = env.get_template('test_ml.html')
      return tmpl.render()
  
    @cherrypy.expose
    def reg(self):
      tmpl = env.get_template('registration_demo.html')
      return tmpl.render()

    @cherrypy.expose
    def view(self, file):
      tmpl = env.get_template('view.html')
      return tmpl.render()

    # @cherrypy.expose
    # def saveworld(self, scene, frame):

    #   # cl = cherrypy.request.headers['Content-Length']
    #   rawbody = cherrypy.request.body.readline().decode('UTF-8')

    #   with open("./data/"+scene +"/label/"+frame+".json",'w') as f:
    #     f.write(rawbody)
      
    #   return "ok"

    @cherrypy.expose
    def saveworldlist(self):

      # cl = cherrypy.request.headers['Content-Length']
      rawbody = cherrypy.request.body.readline().decode('UTF-8')
      data = json.loads(rawbody)

      for d in data:
        scene = d["scene"]
        frame = d["frame"]
        ann = d["annotation"]
        with open("./data/"+scene +"/label/"+frame+".json",'w') as f:
          json.dump(ann, f, indent=2, sort_keys=True)

      return "ok"


    @cherrypy.expose
    @cherrypy.tools.json_out()
    def save_classify_pcd(self):
        """Save PCD file with updated classify values"""
        rawbody = cherrypy.request.body.readline().decode('UTF-8')
        data = json.loads(rawbody)

        scene = data.get("scene")
        frame = data.get("frame")
        classify = data.get("classify")

        if not scene or not frame or classify is None:
            return {"status": "error", "error": "Missing required parameters"}

        try:
            pcd_path = f"./data/{scene}/lidar/{frame}.pcd"

            # Read the original PCD file
            with open(pcd_path, 'rb') as f:
                content = f.read()

            # Find the end of header (DATA line)
            header_end = content.find(b'DATA') + 5
            while content[header_end] != 10:  # Find newline after DATA
                header_end += 1
            header_end += 1  # Skip the newline

            header_bytes = content[:header_end]
            header = header_bytes.decode('utf-8', errors='ignore')
            data_section = content[header_end:]

            # Parse the header to get field information
            lines = header.split('\n')
            fields_line = None
            points_line = None
            sizes = []
            counts = []

            for line in lines:
                if line.startswith('FIELDS'):
                    fields_line = line
                elif line.startswith('POINTS'):
                    points_line = line
                elif line.startswith('SIZE'):
                    sizes = list(map(int, line.split()[1:]))
                elif line.startswith('COUNT'):
                    counts = list(map(int, line.split()[1:]))

            if not fields_line or not points_line or not sizes:
                return {"status": "error", "error": "Invalid PCD header"}

            # Default counts to 1 if not specified
            if not counts:
                counts = [1] * len(sizes)

            # Check if classify field exists
            fields = fields_line.split()[1:]
            classify_index = None

            for i, field in enumerate(fields):
                if field == 'classify':
                    classify_index = i
                    break

            if classify_index is None:
                return {"status": "error", "error": "PCD file has no classify field"}

            # Calculate offset of classify field within each row
            # Offset = sum(size[i] * count[i]) for all fields before classify_index
            classify_offset = 0
            for i in range(classify_index):
                classify_offset += sizes[i] * counts[i]

            # Calculate row size = sum(size[i] * count[i]) for all fields
            row_size = 0
            for i in range(len(sizes)):
                row_size += sizes[i] * counts[i]

            # Get classify field size
            classify_size = sizes[classify_index]

            # Update classify values in the binary data
            data_array = bytearray(data_section)
            num_points = min(len(classify), len(data_array) // row_size)

            for i in range(num_points):
                row_offset = i * row_size + classify_offset
                if row_offset + classify_size <= len(data_array):
                    # Write classify value based on its size (little-endian)
                    if classify_size == 1:
                        data_array[row_offset] = classify[i] & 0xFF
                    elif classify_size == 2:
                        # 2-byte unsigned short (little-endian)
                        data_array[row_offset] = classify[i] & 0xFF
                        data_array[row_offset + 1] = (classify[i] >> 8) & 0xFF
                    elif classify_size == 4:
                        # 4-byte unsigned int (little-endian)
                        data_array[row_offset] = classify[i] & 0xFF
                        data_array[row_offset + 1] = (classify[i] >> 8) & 0xFF
                        data_array[row_offset + 2] = (classify[i] >> 16) & 0xFF
                        data_array[row_offset + 3] = (classify[i] >> 24) & 0xFF

            # Write the updated PCD file using original header bytes
            with open(pcd_path, 'wb') as f:
                f.write(header_bytes)
                f.write(bytes(data_array))

            print(f"Saved classify data to {pcd_path} ({num_points} points)")

            return {"status": "ok", "points": num_points}

        except Exception as e:
            print(f"Error saving classify data: {e}")
            return {"status": "error", "error": str(e)}


    @cherrypy.expose
    @cherrypy.tools.json_out()
    def cropscene(self):
      rawbody = cherrypy.request.body.readline().decode('UTF-8')
      data = json.loads(rawbody)
      
      rawdata = data["rawSceneId"]

      timestamp = rawdata.split("_")[0]

      print("generate scene")
      log_file = "temp/crop-scene-"+timestamp+".log"

      cmd = "python ./tools/dataset_preprocess/crop_scene.py generate "+ \
        rawdata[0:10]+"/"+timestamp + "_preprocessed/dataset_2hz " + \
        "- " +\
        data["startTime"] + " " +\
        data["seconds"] + " " +\
        "\""+ data["desc"] + "\"" +\
        "> " + log_file + " 2>&1"
      print(cmd)

      code = os.system(cmd)

      with open(log_file) as f:
        log = list(map(lambda s: s.strip(), f.readlines()))

      os.system("rm "+log_file)
      
      return {"code": code,
              "log": log
              }


    @cherrypy.expose
    @cherrypy.tools.json_out()
    def checkscene(self, scene):
      ck = check.LabelChecker(os.path.join("./data", scene))
      ck.check()
      print(ck.messages)
      return ck.messages


    # @cherrypy.expose
    # @cherrypy.tools.json_out()
    # def interpolate(self, scene, frame, obj_id):
    #   # interpolate_num = trajectory.predict(scene, obj_id, frame, None)
    #   # return interpolate_num
    #   return 0

    # data  N*3 numpy array
    @cherrypy.expose    
    @cherrypy.tools.json_out()
    def predict_rotation(self):
      cl = cherrypy.request.headers['Content-Length']
      rawbody = cherrypy.request.body.readline().decode('UTF-8')
      
      data = json.loads(rawbody)
      
      return {"angle": pre_annotate.predict_yaw(data["points"])}
      #return {}

    
    @cherrypy.expose    
    @cherrypy.tools.json_out()
    def auto_annotate(self, scene, frame):
      print("auto annotate ", scene, frame)
      return pre_annotate.annotate_file('./data/{}/lidar/{}.pcd'.format(scene,frame))
      


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

      anns = list(map(lambda w:{
                      "scene": w["scene"],
                      "frame": w["frame"],
                      "annotation":scene_reader.read_annotations(w["scene"], w["frame"])},
                      worldlist))

      return anns
        

    # @cherrypy.expose    
    # @cherrypy.tools.json_out()
    # def auto_adjust(self, scene, ref_frame, object_id, adj_frame):
      
    #   #os.chdir("./temp")
    #   os.system("rm ./temp/src.pcd ./temp/tgt.pcd ./temp/out.pcd ./temp/trans.json")


    #   tgt_pcd_file = "./data/"+scene +"/lidar/"+ref_frame+".pcd"
    #   tgt_json_file = "./data/"+scene +"/label/"+ref_frame+".json"

    #   src_pcd_file = "./data/"+scene +"/lidar/"+adj_frame+".pcd"      
    #   src_json_file = "./data/"+scene +"/label/"+adj_frame+".json"

    #   cmd = extract_object_exe +" "+ src_pcd_file + " " + src_json_file + " " + object_id + " " +"./temp/src.pcd"
    #   print(cmd)
    #   os.system(cmd)

    #   cmd = extract_object_exe + " "+ tgt_pcd_file + " " + tgt_json_file + " " + object_id + " " +"./temp/tgt.pcd"
    #   print(cmd)
    #   os.system(cmd)

    #   cmd = registration_exe + " ./temp/tgt.pcd ./temp/src.pcd ./temp/out.pcd ./temp/trans.json"
    #   print(cmd)
    #   os.system(cmd)

    #   with open("./temp/trans.json", "r") as f:
    #     trans = json.load(f)
    #     print(trans)
    #     return trans

    #   return {}

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
      return self.get_all_objs(os.path.join("./data",scene))

    def get_all_objs(self, path):
      label_folder = os.path.join(path, "label")
      if not os.path.isdir(label_folder):
        return []
        
      files = os.listdir(label_folder)

      files = filter(lambda x: x.split(".")[-1]=="json", files)


      def file_2_objs(f):
          with open(f) as fd:
              boxes = json.load(fd)
              objs = [x for x in map(lambda b: {"category":b["obj_type"], "id": b["obj_id"]}, boxes)]
              return objs

      boxes = map(lambda f: file_2_objs(os.path.join(path, "label", f)), files)

      # the following map makes the category-id pairs unique in scene
      all_objs={}
      for x in boxes:
          for o in x:
              
              k = str(o["category"])+"-"+str(o["id"])

              if all_objs.get(k):
                all_objs[k]['count']= all_objs[k]['count']+1
              else:
                all_objs[k]= {
                  "category": o["category"],
                  "id": o["id"],
                  "count": 1
                }

      return [x for x in  all_objs.values()]

if __name__ == '__main__':
    cherrypy.quickstart(Root(), '/', config="server.conf")
else:
    application = cherrypy.Application(Root(), '/', config="server.conf")
