import * as Net from 'net';
import * as path from 'path';
import { DebugProtocol } from '@vscode/debugprotocol';
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

type ResponseCallback = (response: DebugProtocol.Response, arg: any) => void;

export class DebuggeeSession extends EventEmitter {
    private connection: DebuggeeConnection;
    private debuggerSession?: DebuggerSession;
    private callbackMap = new Map<number, Object>();
    public threadId: number = -1;
    public threadName: string = "default";

    constructor(socket: Net.Socket){
        super();
        this.connection = new DebuggeeConnection(socket);
        this.connection.session = this;
        socket.on('end', () => {this.emit('end');});
        socket.on('close', () => {this.emit('close');});
    }

    private registerCallback(request: Object, callbackFunc: ResponseCallback, callbackArgs: any = null){
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
        let command = {
            command:            'welcome',
            arguments: {
                pathMap:            this.debuggerSession?.pathMap,
                stopOnEntry:        this.debuggerSession?.stopOnEntry,
                sourceBasePath:     this.debuggerSession?.sourceBasePath,
                directorySeperator: path.sep,
                breakPoints:        this.debuggerSession?.breakPoints,
            }
        };
        this.send(command);
    }

    public proxy(response: DebugProtocol.Response, args?: any): void {
        let request = new DebuggeeRequest(response, args);
        this.send(request);
    }

    public disconnect(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, callback? : ResponseCallback, callbackArgs: any = null): void {
        let request = new DebuggeeRequest(response, args);
        this.send(request, callback, callbackArgs);
    }

    private send(request: Object, callback? : ResponseCallback, callbackArgs: any = null){
        if (callback !== undefined) {
            this.registerCallback(request, callback, callbackArgs);
        }
        let message = JSON.stringify(request);
        this.connection.send(message);
    }

    public processMessage(message: string){
        let response = JSON.parse(message);
        if (response.body !== undefined && response.body.threadId !== undefined) {
            response.body.threadId = this.threadId;
        }
        if (response.body !== undefined && response.body.allThreadsStopped !== undefined) {
            response.body.allThreadsStopped = false;
        }
        if (response.body !== undefined && response.body.allThreadsContinued !== undefined) {
            response.body.allThreadsContinued = false;
        }
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