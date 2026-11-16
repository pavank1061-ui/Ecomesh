class EchoMeshCapture extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(1024);this.length=0;}
  process(inputs,outputs){
    for(const channel of outputs[0]||[])channel.fill(0);
    const input=inputs[0]?.[0];if(!input)return true;
    let offset=0;
    while(offset<input.length){const count=Math.min(this.buffer.length-this.length,input.length-offset);this.buffer.set(input.subarray(offset,offset+count),this.length);this.length+=count;offset+=count;if(this.length===this.buffer.length){const chunk=this.buffer;this.buffer=new Float32Array(1024);this.length=0;this.port.postMessage(chunk,[chunk.buffer]);}}
    return true;
  }
}
registerProcessor('echomesh-capture',EchoMeshCapture);
