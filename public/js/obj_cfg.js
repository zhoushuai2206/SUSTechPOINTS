// size is the dimension of the object in x/y/z axis, with unit meter.
// 精简后的类别集：只保留 CenterPoint (nuScenes) 会输出并映射进来的类别 + ForkLift。
// popular / 兜底类保持不动，前端 get_obj_cfg_by_type() 找不到类时会 fallback 到 Unknown。

class ObjectCategory
{
    obj_type_map = {
        Car:         {color: '#86af49',  size:[4.5, 1.8, 1.5], attr:["door open", "trunk open"]},
        Truck:       {color: '#00ffff',  size:[10., 2.8, 3.0]},
        Bus:         {color: '#ffff00',  size:[13,  3.0, 3.5]},
        Motorcycle:  {color: '#aaaa00',  size:[1.6, 0.6, 1.2], attr:["umbrella"]},
        Bicycle:     {color: '#ff8800',  size:[1.6, 0.6, 1.2], attr:["laying down"]},
        Pedestrian:  {color: '#ff0000',  size:[0.4, 0.5, 1.7], attr:["umbrella", "sitting", "squating", "bending over", "luggage"]},
        Cone:        {color: '#ff0000',  size:[0.3, 0.3, 0.6]},
        ForkLift:    {color: '#00aaff',  size:[5.0, 1.2, 2.0]},

        // Unknown 是前端兜底类，get_obj_cfg_by_type() 找不到时会返回它，避免 UI 崩掉。
        Unknown:     {color: '#008888',  size:[4.5, 1.8, 1.5]},
    };

    constructor(){
    }

    popularCategories = ["Car", "Truck", "Bus", "Motorcycle", "Bicycle", "Pedestrian", "Cone", "ForkLift"];

    guess_obj_type_by_dimension(scale){
        var max_score = 0;
        var max_name = 0;
        this.popularCategories.forEach(i=>{
            var o = this.obj_type_map[i];
            var scorex = o.size[0]/scale.x;
            var scorey = o.size[1]/scale.y;
            var scorez = o.size[2]/scale.z;

            if (scorex>1) scorex = 1/scorex;
            if (scorey>1) scorey = 1/scorey;
            if (scorez>1) scorez = 1/scorez;

            if (scorex + scorey + scorez > max_score){
                max_score = scorex + scorey + scorez;
                max_name = i;
            }
        });

        console.log("guess type", max_name);
        return max_name;
    }

    global_color_idx = 0;
    get_color_by_id(id){
        let idx = parseInt(id);

        if (!idx)
        {
            idx = this.global_color_idx;
            this.global_color_idx += 1;
        }

        idx %= 33;
        idx = idx*19 % 33;

        return {
            x: idx*8/256.0,
            y: 1- idx*8/256.0,
            z: (idx<16)?(idx*2*8/256.0):((32-idx)*2*8/256.0),
        };
    }

    get_color_by_category(category){
        let target_color_hex = parseInt("0x"+this.get_obj_cfg_by_type(category).color.slice(1));

        return {
            x: (target_color_hex/256/256)/255.0,
            y: (target_color_hex/256 % 256)/255.0,
            z: (target_color_hex % 256)/255.0,
        };
    }

    get_obj_cfg_by_type(name){
        if (this.obj_type_map[name]){
            return this.obj_type_map[name];
        }
        else{
            return this.obj_type_map["Unknown"];
        }
    }
}


let globalObjectCategory = new ObjectCategory();

export {globalObjectCategory};
