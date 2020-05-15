function ArControllerComponent( o )
{
    this.farPlane = 1500;
    this.nearPlane= 0.01;
    this.defaultMarkerWidth = 80;
    this.cameraCalibrationFile = 'data/camera_para.dat';
    this._video = undefined;
    this._arTrackable2DList = [];
    this._defaultMarkerWidthUnit = 'mm';
    this._visibleTrackables = [];
    this.initVideo = true;
    this.running = false;
    this.time = 0;
    //Square tracking options
    this.trackableDetectionModeList = {
        /*'Trackable square pattern (color)' : artoolkit.AR_TEMPLATE_MATCHING_COLOR,
        'Trackable square pattern (mono)' : artoolkit.AR_TEMPLATE_MATCHING_MONO,
        'Trackable square barcode' : artoolkit.AR_MATRIX_CODE_DETECTION,
        'Trackable square pattern and barcode (color)' : artoolkit.AR_TEMPLATE_MATCHING_COLOR_AND_MATRIX,
        'Trackable square pattern and barcode (mono)' : artoolkit.AR_TEMPLATE_MATCHING_MONO_AND_MATRIX*/
    };

    this.trackableDetectionMode =''; //artoolkit.AR_TEMPLATE_MATCHING_COLOR_AND_MATRIX;

    // Register orientation change listener to be informed on orientation change events
    // https://stackoverflow.com/questions/1649086/detect-rotation-of-android-phone-in-the-browser-with-javascript
    // Detect whether device supports orientationchange event, otherwise fall back to
    // the resize event.
    this.supportsOrientationChange = "onorientationchange" in window;
    this.orientationEvent = this.supportsOrientationChange ? "orientationchange" : "resize";

    window.addEventListener(this.orientationEvent, function() {
        // Also window resize events are received here. Unfortunately if we don't have a running AR scene we don't have an arController and we see errors in the log
        // because of that we check if there is an ARController object available
        //if(this.arController){
            console.log("window.orientation " + window.orientation + " screen.orientation " + screen.orientation );
            this._setupCameraForScreenOrientation(screen.orientation.type);
        //}
    }.bind(this));

    if(o)
        this.configure(o);
}

ArControllerComponent.arCameraName = 'arcamera';
ArControllerComponent.arBackgroundCamera = 'arbackgroundcamera';
ArControllerComponent.arBackground = 'arBackground';

ArControllerComponent["@inspector"] = function( arController, inspector )
{
    inspector.addTitle("AR Controller");
    inspector.addCombo("Trackable detection mode", arController.trackableDetectionMode, { values: arController.trackableDetectionModeList, callback: function (value) { arController.trackableDetectionMode = value }});

    inspector.addNumber("Far plane", arController.farPlane, {callback: v => arController.farPlane = v, precision:2, step:1});
    inspector.addNumber("Near plane", arController.nearPlane, {callback: v => arController.nearPlane = v, precision:2, step:0.01});

    inspector.addNumber("Trackable width", arController.defaultMarkerWidth, {callback: v => arController.defaultMarkerWidth = v, precision:0, step:1, units: arController._defaultMarkerWidthUnit, min: 10});
}

LS.registerComponent(ArControllerComponent);

ArControllerComponent.prototype.onAddedToScene = function( scene ){
    LEvent.bind(scene,"start",this.startAR,this);
    LEvent.bind(scene,'finish',this.stopAR, this );
}
ArControllerComponent.prototype.onRemovedFromScene = function( scene ) {
    LEvent.unbind(scene,"start", this.startAR, this);
    LEvent.unbind(scene,'finish',this.stopAR, this );
}

ArControllerComponent.prototype.startAR = function() {
    console.log("Start AR");
    this._video = this.getUserMedia()
    this._arTrackable2DList.forEach(arTrackable => {
      var self = this;
      window.addEventListener('getDataFromWorker', function(ev) {

        const markerIndex = ev.detail.data.index;
        const markerType = ev.detail.data.type;
        const marker = ev.detail.data.marker;

        if (ev.detail.data.type === 2) {
          trackableId = ev.detail.data.marker.id;
        }
        if (trackableId !== -1) {
            console.log("saw a trackable with id", trackableId);

            let markerRoot = arTrackable.attachedGameObject;
            arTrackable.visible = true;
            console.log("visible")
            // Note that you need to copy the values of the transformation matrix,
            // as the event transformation matrix is reused for each marker event
            // sent by an ARController.
            var transform = ev.detail.data.matrix;

            // Apply transform to marker root

            let cameraGlobalMatrix = self.arCameraNode.transform.getGlobalMatrix();
            let markerRootMatrix = mat4.create();
            mat4.multiply(markerRootMatrix, cameraGlobalMatrix, transform);
            let outQuat = quat.create();
            quat.fromMat4(outQuat,markerRootMatrix);
            outQuat[0]*=-1;
            markerRoot.transform.setPosition(vec3.fromValues(markerRootMatrix[12],markerRootMatrix[13]*-1,markerRootMatrix[14]*-1));
            markerRoot.transform.setRotation(outQuat);
        }
    });
  });
};

ArControllerComponent.prototype.getUserMedia = async function() {
  var self = this;
  const constraints = {
    audio: false,
    video: {
      facingMode: "environment",
      width: 640,
      height: 480
    }
  };

  var texture = undefined;
  //basic shader
  //create basic matrices for cameras and transformation
  var proj = mat4.create();
  var view = mat4.create();
  var model = mat4.create();
  var mvp = mat4.create();
  var temp = mat4.create();
  //basic phong shader
  var shader = new Shader('\
      precision highp float;\
      attribute vec3 a_vertex;\
      attribute vec3 a_normal;\
      attribute vec2 a_coord;\
      varying vec3 v_normal;\
      varying vec2 v_coord;\
      uniform mat4 u_mvp;\
      uniform mat4 u_model;\
      void main() {\
        v_coord = a_coord;\
        gl_Position =u_mvp* vec4(a_vertex,1.0);\
      }\
      ', '\
      precision highp float;\
      varying vec3 v_normal;\
      varying vec2 v_coord;\
      uniform vec3 u_lightvector;\
      uniform vec4 u_color;\
      uniform sampler2D u_texture;\
      void main() {\
        vec4 color =  texture2D( u_texture, v_coord);\
        gl_FragColor = color ;\
      }\
    ');

  var video = document.createElement('video');
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  console.log('got video', video);

  video.onloadedmetadata = function() {
    var maxARVideoSize = 320;
    var maxSize = maxARVideoSize || Math.max(video.videoWidth, video.videoHeight);
    var f = maxSize / Math.max(video.videoWidth, video.videoHeight);
    var w = f * video.videoWidth;
    var h = f * video.videoHeight;
    if (video.videoWidth < video.videoHeight) {
      var tmp = w;
      w = h;
      h = tmp;
    }

    var scale = 1;
    var mesh = GL.Mesh.plane({xy: true,width: video.videoWidth,height:video.videoHeight});
    var type = gl.HIGH_PRECISION_FORMAT;

    self._arTrackable2DList.forEach(trackable2D => {
        if(trackable2D._trackableType === trackable2D.trackableTypes[2])
        {
            startWorker(trackable2D.trackablePathNft, video, w, h);
        }
    });

    const sceneRoot = LS.GlobalScene.root;
    this.running = true;
    let scene = LS.GlobalScene;

    //Add the AR-Camera to the scene
    self.arCameraNode = new LS.SceneNode(ArControllerComponent.arCameraName);
    self.arCamera = new LS.Camera();
    self.arCamera.background_color=[0, 0, 0, 0];
    self.arCamera.clear_color = true; //We must clear buffer from first camera.
    self.arCameraNode.addComponent(self.arCamera);

    sceneRoot.addChild(self.arCameraNode, 0);
    LS.GlobalScene.root.getComponent(LS.Camera).background_color=[0, 0, 0, 0];
    self._setupCameraForScreenOrientation(screen.orientation.type);

    // On each frame, detect markers, update their positions and
    // render the frame on the renderer.
    texture = Texture.fromVideo(video,{minFilter: gl.NEAREST});
    var tick = function() {
      if(!this.running)
          return;

      requestAnimationFrame(tick);
      if (texture){
        gl.clearColor(0.1,0.1,0.1,1);
        gl.enable( gl.DEPTH_TEST );
        texture.uploadImage(video);

        mat4.multiply(mvp,self.arCamera.getViewProjectionMatrix(),model);
        var translation = vec3.create();
        vec3.set (translation, 0, 0 ,-580);
        mat4.translate (mvp, mvp, translation);

        //compute rotation matrix for normals
        texture.bind(0);

        //render mesh using the shader

        shader.uniforms({
          u_color: [1,1,1,1],
          u_model: model,
          u_texture: 0,
          u_mvp: mvp
        }).draw(mesh);
      }
      // Hide the marker, as we don't know if it's visible in this frame.
      for (var trackable2D of self._arTrackable2DList){
          trackable2D._previousState = trackable2D._currentState;
          trackable2D._currentState = undefined;
      }

      // Process detects markers in the video frame and sends
      // getMarker events to the event listeners.
      // adjust to 16 fps
      if (Math.abs(self.time-new Date().getTime())>60)
        {
          self.time = new Date().getTime();
          // If after the processing trackable2D.currentState is still undefined and the previous state wasn't undefined we assume that the marker was not visible within that frame
          self._arTrackable2DList.forEach(arTrackable => {
              if( arTrackable._currentState === undefined){
                  arTrackable.visible = false;
              }
          });
        }
      // Render the updated scene.
      LS.GlobalScene.refresh();
    }.bind(this);
    tick();
  } // end of load video
  return video;
}

ArControllerComponent.prototype.stopAR = function(){
    console.log("Stop AR");
    this.running = false;
    if(this._video !== undefined){
      var videoElem = this._video;
      var stream = videoElem.srcObject;
      if(stream){
        var tracks = stream.getVideoTracks();
        tracks.forEach(function(track) {
          track.stop();
        });
        videoElem.srcObject = null;
        videoElem.src = null;
        videoElem.remove();
      }
    }

    if(this.arCamera)
        LS.GlobalScene.root.removeChild(this.arCamera);

    var arBackgroundCamera = LS.GlobalScene.getNode(ArControllerComponent.arBackgroundCamera);
    if(arBackgroundCamera)
        LS.GlobalScene.root.removeChild(arBackgroundCamera);

    var arBackground = LS.GlobalScene.getNode(ArControllerComponent.arBackground);
    if(arBackground)
        LS.GlobalScene.root.removeChild(arBackground);
    this.initVideo = true;

};

ArControllerComponent.prototype.registerTrackable = function(arTrackable2D){
    console.log("Register trackable");
    this._arTrackable2DList.push(arTrackable2D);
}

ArControllerComponent.prototype.unRegisterTrackable = function(arTrackable2D){
    console.log(`Unregister trackable`);
    const indexToRemove = this._arTrackable2DList.indexOf(arTrackable2D);
    if(indexToRemove > -1) {
        this._arTrackable2DList.splice(indexToRemove,1);
    }
}

ArControllerComponent.prototype._setupCameraForScreenOrientation = function (orientation) {

    // Camera matrix is used to define the “perspective” that the camera would see.
    // The camera matrix returned from arController.getCameraMatrix() is already the OpenGLProjectionMatrix
    // LiteScene supports setting a custom projection matrix but an update of LiteScene is needed to do that.

    //Save the original projection matrix so that there is a reference
    if(this.originalProjectionMatrix === undefined) {
        this.originalProjectionMatrix = this.arCamera.getProjectionMatrix();
    }

    if ( orientation.includes('portrait') ) {
        //this.arController.orientation = 'portrait';
        //this.arController.videoWidth = this._video.videoHeight;
        //this.arController.videoHeight = this._video.videoWidth;

        // TODO once we have proper handling of calibration file we use this
        // let cameraProjectionMatrix = this.arController.getCameraMatrix();
        // mat4.rotateX(cameraProjectionMatrix, cameraProjectionMatrix, 3.14159);  // Rotate around x by 180°

        //let cameraProjectionMatrix = mat4.create();
        //mat4.copy(cameraProjectionMatrix, this.originalProjectionMatrix);
        //mat4.rotateZ(cameraProjectionMatrix, cameraProjectionMatrix, 1.5708);       // Rotate around z by 90°
        //this.arCamera.setCustomProjectionMatrix(cameraProjectionMatrix);
    } else {
        //this.arController.orientation = 'landscape';
        // this.arController.videoWidth = this._video.videoWidth;
        // this.arController.videoHeight = this._video.videoHeight;
        // // TODO: once we have proper handling of calibration file we use this
        //  let cameraProjectionMatrix = this.arController.getCameraMatrix();
        //  mat4.rotateX(cameraProjectionMatrix, cameraProjectionMatrix, 3.14159);
        // // arCamera.setCustomProjectionMatrix(cameraProjectionMatrix);
        //
        // this.arCamera.setCustomProjectionMatrix(this.originalProjectionMatrix);
    }
}
