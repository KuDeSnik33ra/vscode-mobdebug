import * as Net from 'net';
import * as path from 'path';
import { DebugProtocol } from 'vscode-debugprotocol';
import { DebuggeeConnection } from "./Connection";
import { DebuggerSession } from "../Debugger/Session";
import { EventEmitter } from 'events';

class DebuggeeRequest {
    seq: number;
    type: string = 'request';
    command: string;
    arguments?: any;

    constructor(response: DebugProtocol.Response, args?: any){
        this.seq       = response.request_seq;
        this.command   = response.command;
        this.arguments = args;
    }
}

export class DebuggeeSession extends EventEmitter {
    private connection: DebuggeeConnection;
    private debuggerSession?: DebuggerSession;
    private callbackMap = new Map<number, Object>();

    constructor(socket: Net.Socket){
        super();
        this.connection = new DebuggeeConnection(socket);
        this.connection.session = this;
        socket.on('end', () => {this.emit('end');});
        socket.on('close', () => {this.emit('close');});
    }

    private registerCallback(request: Object, callbackFunc, callbackArgs = null){
        let requestSeq: number | undefined = request['seq'];
        if (requestSeq === undefined || requestSeq === 0) {
            // TODO: arg error - callback can be set only for request type
            return;
        }
        let cb = {
            callback: callbackFunc,
            args:     callbackArgs,
        };
        this.callbackMap.set(requestSeq, cb);
    }

    private invokeCallback(response: Object){
        let requestSeq: number | undefined = response['request_seq'];
        if (requestSeq === undefined || requestSeq === 0) {
            return;
        }
        let cb = this.callbackMap.get(requestSeq);
        if (cb === undefined) {
            return;
        }
        this.callbackMap.delete(requestSeq);
        let callbackFunc = cb['callback'];
        let callbackArgs = cb['args'];
        if (callbackArgs !== null) {
            callbackFunc(response, callbackArgs);
        } else {
            callbackFunc(response);
        }
    }

    private welcome() {
        let sourceBasePath     = this.debuggerSession?.sourceBasePath;
        let directorySeperator = path.sep;
        let command = {
            command:            'welcome',
            sourceBasePath:     sourceBasePath,
            directorySeperator: directorySeperator,
        };
        this.send(command);
    }

    public proxy(response: DebugProtocol.Response, args?: any): void {
        let request = new DebuggeeRequest(response, args);
        this.send(request);
    }

    private send(request: Object, callbackFunc = null, callbackArgs = null){
        if (callbackFunc !== null) {
            this.registerCallback(request, callbackFunc, callbackArgs);
        }
        let message = JSON.stringify(request);
        this.connection.send(message);
    }

    public processMessage(message: string){
        let response = JSON.parse(message);
        this.invokeCallback(response);
        this.emit(response.type, response);
    }

    public processSession(debuggerSession: DebuggerSession){
        this.debuggerSession = debuggerSession;
        this.connection.process();
        this.welcome();
    }

    public stop(){
        this.connection.stop();
    }
}