/**
 * @author Filipe Caixeta / http://filipecaixeta.com.br
 * @author Mugen87 / https://github.com/Mugen87
 *
 * Description: A THREE loader for PCD ascii and binary files.
 *
 * Limitations: Compressed binary files are not supported.
 *
 */

 import {
	DefaultLoadingManager,
	FileLoader,	
	LoaderUtils,	
} from "./three.module.js";


var PCDLoader = function ( manager ) {

	this.manager = ( manager !== undefined ) ? manager : DefaultLoadingManager;
	this.littleEndian = true;

};

function decompressLZF(inData, outLength) {
	var inLength = inData.length
	var outData = new Uint8Array(outLength)
	var inPtr = 0
	var outPtr = 0
	var ctrl
	var len
	var ref
	do {
	  ctrl = inData[inPtr++]
	  if (ctrl < 1 << 5) {
		ctrl++
		if (outPtr + ctrl > outLength) throw new Error('Output buffer is not large enough')
		if (inPtr + ctrl > inLength) throw new Error('Invalid compressed data')
		do {
		  outData[outPtr++] = inData[inPtr++]
		} while (--ctrl)
	  } else {
		len = ctrl >> 5
		ref = outPtr - ((ctrl & 0x1f) << 8) - 1
		if (inPtr >= inLength) throw new Error('Invalid compressed data')
		if (len === 7) {
		  len += inData[inPtr++]
		  if (inPtr >= inLength) throw new Error('Invalid compressed data')
		}

		ref -= inData[inPtr++]
		if (outPtr + len + 2 > outLength) throw new Error('Output buffer is not large enough')
		if (ref < 0) throw new Error('Invalid compressed data')
		if (ref >= outPtr) throw new Error('Invalid compressed data')
		do {
		  outData[outPtr++] = outData[ref++]
		} while (--len + 2)
	  }
	} while (inPtr < inLength)

	return outData
  }


PCDLoader.prototype = {

	constructor: PCDLoader,

	load: function ( url, onLoad, onProgress, onError, onFileLoaded ) {

		var scope = this;

		var loader = new FileLoader( scope.manager );
		loader.setPath( scope.path );
		loader.setResponseType( 'arraybuffer' );
		loader.load( url, function ( data ) {

			try {
				if (onFileLoaded)
					onFileLoaded();
				onLoad( scope.parse( data, url) );
			} catch ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					throw e;

				}

			}

		}, onProgress, onError );

	},

	setPath: function ( value ) {

		this.path = value;
		return this;

	},

	parse: function(data, url){
		// URL 有可能带 cache-busting query 串（例如 `foo.pcd?_=123`），先剥掉再
		// 判扩展名，否则会被误判成非 pcd 并走 parseBin 拿到一堆错乱字段。
		var cleanUrl = url.split('?')[0].split('#')[0];
		var addr = cleanUrl.split(".");
		var file_ext = addr[addr.length-1];

		if (file_ext === "pcd")
			return this.parsePcd(data, url);
		else {
			console.log("load", file_ext, "file");
			return this.parseBin(data, url);
		}
			
	},

	parseBin: function(data, url){
		var dataview = new DataView( data, 0);

		var position = [];
		var normal = [];
		var color = [];
		var intensity = [];
		var classify = [];
		//kitti format, xyzi
		var offset = 0;

		for ( var row = 0; row < data.byteLength/(4*4); row += 1 ) {
			position.push( dataview.getFloat32( row*16 + 0, this.littleEndian ) );
			position.push( dataview.getFloat32( row*16 + 4, this.littleEndian ) );
			position.push( dataview.getFloat32( row*16 + 8, this.littleEndian ) );
			intensity.push(dataview.getFloat32( row*16 + 12, this.littleEndian ) )
		}

		return {
			position: position,
			color: color,
			normal: normal,
			intensity: intensity,
			classify: classify,
		};
	},

	parsePcd: function ( data, url) {
	
		function parseHeader( data ) {

			var PCDheader = {};
			var result1 = data.search( /[\r\n]DATA\s(\S*)\s/i );
			var result2 = /[\r\n]DATA\s(\S*)\s/i.exec( data.substr( result1 - 1 ) );

			PCDheader.data = result2[ 1 ];
			PCDheader.headerLen = result2[ 0 ].length + result1;
			PCDheader.str = data.substr( 0, PCDheader.headerLen );

			// remove comments

			PCDheader.str = PCDheader.str.replace( /\#.*/gi, '' );

			// parse

			PCDheader.version = /VERSION (.*)/i.exec( PCDheader.str );
			PCDheader.fields = /FIELDS (.*)/i.exec( PCDheader.str );
			PCDheader.size = /SIZE (.*)/i.exec( PCDheader.str );
			PCDheader.type = /TYPE (.*)/i.exec( PCDheader.str );
			PCDheader.count = /COUNT (.*)/i.exec( PCDheader.str );
			PCDheader.width = /WIDTH (.*)/i.exec( PCDheader.str );
			PCDheader.height = /HEIGHT (.*)/i.exec( PCDheader.str );
			PCDheader.viewpoint = /VIEWPOINT (.*)/i.exec( PCDheader.str );
			PCDheader.points = /POINTS (.*)/i.exec( PCDheader.str );

			// evaluate

			if ( PCDheader.version !== null )
				PCDheader.version = parseFloat( PCDheader.version[ 1 ] );

			if ( PCDheader.fields !== null )
				PCDheader.fields = PCDheader.fields[ 1 ].split( ' ' );

			if ( PCDheader.type !== null )
				PCDheader.type = PCDheader.type[ 1 ].split( ' ' );

			if ( PCDheader.width !== null )
				PCDheader.width = parseInt( PCDheader.width[ 1 ] );

			if ( PCDheader.height !== null )
				PCDheader.height = parseInt( PCDheader.height[ 1 ] );

			if ( PCDheader.viewpoint !== null )
				PCDheader.viewpoint = PCDheader.viewpoint[ 1 ];

			if ( PCDheader.points !== null )
				PCDheader.points = parseInt( PCDheader.points[ 1 ], 10 );

			if ( PCDheader.points === null )
				PCDheader.points = PCDheader.width * PCDheader.height;

			if ( PCDheader.size !== null ) {

				PCDheader.size = PCDheader.size[ 1 ].split( ' ' ).map( function ( x ) {

					return parseInt( x, 10 );

				} );

			}

			if ( PCDheader.count !== null ) {

				PCDheader.count = PCDheader.count[ 1 ].split( ' ' ).map( function ( x ) {

					return parseInt( x, 10 );

				} );

			} else {

				PCDheader.count = [];

				for ( var i = 0, l = PCDheader.fields.length; i < l; i ++ ) {

					PCDheader.count.push( 1 );

				}

			}

			PCDheader.offset = {};

			var sizeSum = 0;

			for ( var i = 0, l = PCDheader.fields.length; i < l; i ++ ) {

				if ( PCDheader.data === 'ascii' || PCDheader.data === 'ascill') {

					PCDheader.offset[ PCDheader.fields[ i ] ] = i;

				} else {

					PCDheader.offset[ PCDheader.fields[ i ] ] = sizeSum;
					sizeSum += PCDheader.size[ i ] * PCDheader.count[ i ];

				}

			}

			// for binary only

			PCDheader.rowSize = sizeSum;

			// This project's PCDs always carry a per-point `classify` field
			// declared as TYPE U / SIZE 1 / COUNT 1 (see tools/add_classify_field.py).
			// Validate it up front so a mismatching producer is reported here
			// instead of silently degrading Classify Mode.
			var classifyIndex = PCDheader.fields.indexOf( 'classify' );
			if ( classifyIndex < 0 ) {
				throw new Error( 'PCDLoader: PCD header has no `classify` field: ' + PCDheader.fields.join( ' ' ) );
			}
			if ( PCDheader.type[ classifyIndex ] !== 'U' || PCDheader.size[ classifyIndex ] !== 1 ||
				 PCDheader.count[ classifyIndex ] !== 1 ) {
				throw new Error( 'PCDLoader: `classify` must be TYPE U / SIZE 1 / COUNT 1, got TYPE ' +
					PCDheader.type[ classifyIndex ] + ' / SIZE ' + PCDheader.size[ classifyIndex ] +
					' / COUNT ' + PCDheader.count[ classifyIndex ] );
			}

			return PCDheader;

		}

		var textData = LoaderUtils.decodeText( new Uint8Array( data ) );

		// parse header (always ascii format)

		var PCDheader = parseHeader( textData );

		// parse data

		var position = [];
		var normal = [];
		var color = [];
		var velocity = [];
		var intensity = [];
		var classify = [];

		// `filterPoint()` below drops invalid points (NaN / origin), so the arrays
		// above are shorter than the PCD's POINTS count. Keep a mapping from the
		// kept-point index back to its original row index, plus the untouched
		// per-row classify values, so callers can write results back into a
		// full-length, correctly-aligned array (see classify_annotator saveToPCD).
		var srcIndex = [];
		var srcClassify = [];

		// ascii

		function filterPoint(x,y,z)
		{
			if (isNaN(x))
				return true;
			if (x == 0 && y== 0 && z==0)
				return true;
			// if (z >=2)
			// 	return true;
		}


		if ( PCDheader.data === 'ascii' || PCDheader.data === 'ascill') {

			var offset = PCDheader.offset;
			var pcdData = textData.substr( PCDheader.headerLen );
			var lines = pcdData.split( '\n' );

			var intensity_index = PCDheader.fields.findIndex(n=>n==="intensity");
			var intensity_type = "F";
			var intensity_size = 4;

			if (intensity_index >= 0){
				intensity_type = PCDheader.type[intensity_index];
				intensity_size = PCDheader.size[intensity_index];
			}

			for ( var i = 0, l = lines.length, srcRow = -1; i < l; i ++ ) {

				if ( lines[ i ] === '' ) continue;

				var line = lines[ i ].split( ' ' );
				srcRow ++;

				// Record this row's classify value regardless of filtering, so the
				// original per-row values stay available for a full-length write-back.
				srcClassify.push( parseInt( line[ offset.classify ] ) || 0 );

				// First, check if this point should be filtered
				let shouldFilter = false;
				if ( offset.x !== undefined ) {
					var x,y,z;
					x = parseFloat( line[ offset.x ] );
					y = parseFloat( line[ offset.y ] );
					z = parseFloat( line[ offset.z ] );

					shouldFilter = filterPoint(x,y,z);

					if (!shouldFilter) {
						srcIndex.push( srcRow );
						position.push( x );
						position.push( y );
						position.push( z );
					}
				}

				// Only process other attributes if point was not filtered
				if (!shouldFilter) {
					if ( offset.rgb !== undefined ) {
						var rgb = parseFloat( line[ offset.rgb ] );
						var r = ( rgb >> 16 ) & 0x0000ff;
						var g = ( rgb >> 8 ) & 0x0000ff;
						var b = ( rgb >> 0 ) & 0x0000ff;
						color.push( r / 255, g / 255, b / 255 );
					}

					if ( offset.normal_x !== undefined ) {
						normal.push( parseFloat( line[ offset.normal_x ] ) );
						normal.push( parseFloat( line[ offset.normal_y ] ) );
						normal.push( parseFloat( line[ offset.normal_z ] ) );
					}

					if ( offset.vx !== undefined ) {
						var vx,vy;
						vx = parseFloat( line[ offset.vx ] );
						vy = parseFloat( line[ offset.vy ] );

						velocity.push(vx);
						velocity.push(vy);
						velocity.push(0);
					}

					if (offset.intensity !== undefined) {
						intensity.push( parseInt( line[ offset.intensity ] ));
					}

					if (offset.classify !== undefined) {
						classify.push( parseInt( line[ offset.classify ] ) || 0 );
					}
				}

			}

		}

		// binary

		if ( PCDheader.data === 'binary_compressed' ) {

			var sizes = new Uint32Array( data.slice( PCDheader.headerLen, PCDheader.headerLen + 8 ) );
			var compressedSize = sizes[ 0 ];
			var decompressedSize = sizes[ 1 ];
			var decompressed = decompressLZF( new Uint8Array( data, PCDheader.headerLen + 8, compressedSize ), decompressedSize );
			var dataview = new DataView( decompressed.buffer );
			
			var offset = PCDheader.offset;
			var intensity_index = PCDheader.fields.findIndex(n=>n==="intensity");
			var intensity_type = "F";
			var intensity_size = 4;

			if (intensity_index >= 0){
				intensity_type = PCDheader.type[intensity_index];
				intensity_size = PCDheader.size[intensity_index];
			}

			let size = {};
			
			PCDheader.fields.forEach((n,i)=>size[n]=PCDheader.size[i])


			for ( var i = 0; i < PCDheader.points; i ++ ) {

				// binary_compressed keeps every point, so the mapping is 1:1.
				srcIndex.push( i );

				if ( offset.x !== undefined ) {
				
					if (size.x==8)
					{
						position.push( dataview.getFloat64( ( PCDheader.points * offset.x ) + size.x * i, this.littleEndian ) );
						position.push( dataview.getFloat64( ( PCDheader.points * offset.y ) + size.y * i, this.littleEndian ) );
						position.push( dataview.getFloat64( ( PCDheader.points * offset.z ) + size.z * i, this.littleEndian ) );
					}
					else
					{
						position.push( dataview.getFloat32( ( PCDheader.points * offset.x ) + size.x * i, this.littleEndian ) );
						position.push( dataview.getFloat32( ( PCDheader.points * offset.y ) + size.y * i, this.littleEndian ) );
						position.push( dataview.getFloat32( ( PCDheader.points * offset.z ) + size.z * i, this.littleEndian ) );
					}
					
				}

				if ( offset.vx !== undefined ) {
				
					if (size.vx==8)
					{
						velocity.push( dataview.getFloat64( ( PCDheader.points * offset.vx ) + size.vx * i, this.littleEndian ) );
						velocity.push( dataview.getFloat64( ( PCDheader.points * offset.vy ) + size.vy * i, this.littleEndian ) );
						velocity.push( 0 );
					}
					else
					{
						velocity.push( dataview.getFloat32( ( PCDheader.points * offset.vx ) + size.vx * i, this.littleEndian ) );
						velocity.push( dataview.getFloat32( ( PCDheader.points * offset.vy ) + size.vy * i, this.littleEndian ) );
						velocity.push( 0 );
					}
					
				}
				
				if (offset.intensity !== undefined) {
					if (intensity_type == "U" && intensity_size == 1){
						intensity.push( dataview.getUint8(PCDheader.points * offset.intensity + size.intensity*i));
					}
					else if (intensity_type == "F" && intensity_size == 4){
						intensity.push( dataview.getFloat32(PCDheader.points * offset.intensity + size.intensity*i, this.littleEndian));
					}
				}

				classify.push( dataview.getUint8(PCDheader.points * offset.classify + size.classify*i));
				srcClassify.push( classify[classify.length-1] );
			}

		}
		else if ( PCDheader.data === 'binary' ) {

			var dataview = new DataView( data, PCDheader.headerLen );
			var offset = PCDheader.offset;

			var intensity_index = PCDheader.fields.findIndex(n=>n==="intensity");
			var intensity_type = "F";
			var intensity_size = 4;

			if (intensity_index >= 0){
				intensity_type = PCDheader.type[intensity_index];
				intensity_size = PCDheader.size[intensity_index];
			}

			let x_index = PCDheader.fields.findIndex(n=>n==="x");
			let x_size = 4;
			let x_type = 'F';
			if (x_index >= 0){
				x_type = PCDheader.type[x_index];
				x_size = PCDheader.size[x_index];
			}


			for ( var i = 0, row = 0; i < PCDheader.points; i ++, row += PCDheader.rowSize ) {

				// Record every row's classify value before filtering, so the
				// original values remain aligned with the file's POINTS count.
				srcClassify.push( dataview.getUint8(row + offset.classify) );

				// First, check if this point should be filtered
				let shouldFilter = false;
				if ( offset.x !== undefined ) {
					let getFloat =  (x_size==8)? dataview.getFloat64.bind(dataview) : dataview.getFloat32.bind(dataview);

					let x = getFloat( row + offset.x, this.littleEndian );
					let y = getFloat( row + offset.y, this.littleEndian );
					let z = getFloat( row + offset.z, this.littleEndian );

					shouldFilter = filterPoint(x,y,z);

					if (!shouldFilter) {
						srcIndex.push( i );
						position.push( x );
						position.push( y );
						position.push( z );
					}
				}

				// Only process other attributes if point was not filtered
				if (!shouldFilter) {
					if ( offset.rgb !== undefined ) {
						color.push( dataview.getUint8( row + offset.rgb + 2 ) / 255.0 );
						color.push( dataview.getUint8( row + offset.rgb + 1 ) / 255.0 );
						color.push( dataview.getUint8( row + offset.rgb + 0 ) / 255.0 );
					}

					if ( offset.normal_x !== undefined ) {
						normal.push( dataview.getFloat32( row + offset.normal_x, this.littleEndian ) );
						normal.push( dataview.getFloat32( row + offset.normal_y, this.littleEndian ) );
						normal.push( dataview.getFloat32( row + offset.normal_z, this.littleEndian ) );
					}

					if ( offset.vx !== undefined ) {
						velocity.push( dataview.getFloat32( row + offset.vx, this.littleEndian ) );
						velocity.push( dataview.getFloat32( row + offset.vy, this.littleEndian ) );
						velocity.push( 0 );
					}

					if (offset.intensity !== undefined) {
						if (intensity_type == "U" && intensity_size == 1){
							intensity.push( dataview.getUint8(row + offset.intensity));
						}
						else if (intensity_type == "F" && intensity_size == 4){
							intensity.push( dataview.getFloat32(row + offset.intensity, this.littleEndian));
						}
					}

					if (offset.classify !== undefined) {
						classify.push( dataview.getUint8(row + offset.classify));
					}
				}
			}

		}

		// `classify` (U1) is a mandatory field of the PCDs used by this project:
		// every point cloud carries the per-point classification annotation, so
		// there is no "missing field" fallback here. Fail loudly instead of
		// silently handing back all-zero classifications, which would look like
		// "annotation lost" in Classify Mode.
		if (classify.length !== position.length / 3){
			throw new Error(
				'PCDLoader: `classify` count (' + classify.length + ') does not match point count (' +
				position.length / 3 + ') for ' + url);
		}

		return {
			position: position,
			color: color,
			normal: normal,
			velocity: velocity,
			intensity: intensity,
			classify: classify,
			// Mapping back to the source file rows (see srcIndex declaration above).
			srcIndex: srcIndex,
			srcClassify: srcClassify,
			srcPointCount: PCDheader.points,
		};
		
	}

};

export { PCDLoader };
