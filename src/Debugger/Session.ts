import { Subject } from 'await-notify';
import { LoggingDebugSession, TerminatedEvent, OutputEvent, InitializedEvent, ThreadEvent, ExitedEvent, Thread } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { DebugLogger } from '../VSCode/LogManager';
import { DebuggeeSession } from '../Debuggee/Session';
import { DebuggeeSessionFactory } from '../Debuggee/SessionFactory';
import { Constants } from '../Constants';
import { IDebuggerSessionConfig } from './ISessionConfig';
import { IDebuggerSessionStdio } from "./ISessionStdio";
import { launchScript, IDebuggeeProcess, DebuggeeTerminalMode } from '../Debuggee/Process';
import { assert } from 'console';
import { normalize as path_normalize, join as path_join, isAbsolute as path_is_absolute } from 'path';

class PathMap {
    private localPrefix: string;
    private remotePrefix: string;
    constructor(l:string, r:string){
        this.localPrefix = l;
        this.remotePrefix = r;
    }

    toJSON(): Array<string> {
        return [this.remotePrefix, this.localPrefix];
    }
};

export class DebuggerSession extends LoggingDebugSession implements IDebuggerSessionConfig, IDebuggerSessionStdio {
    private debuggeeServer?: DebuggeeSessionFactory;
    private debuggee: DebuggeeSession[] = [];
    private currentThread?: number;
    private pendingResponseCount: number = 0;

    private configurationDone = new Subject();
    private debugProcess?: IDebuggeeProcess;

    // Common configuration
    public sourceEncoding:BufferEncoding = 'utf-8';
    public consoleEncoding:BufferEncoding = 'utf-8';
    public sourceBasePath:string = '';
    public workingDirectory:string = '';
    public debuggeeHost:string = '';
    public debuggeePort:number = Constants.defaultPort;
    public stopOnEntry:boolean = false;
    public launchExecutable:string = '';
    public launchInterpreter:string = '';
    public launchArguments?:Array<string>;
    public pathMap?: Array<PathMap>;
    public breakPoints: Map<string, string> = new Map<string, string>();

    // Attach configuration
    public terminalMode?: DebuggeeTerminalMode;

    // Launch configuration
    public noDebug?:boolean;
    public launchEnveronment?: { [key: string]: string | null | undefined };

    public constructor() {
        super(Constants.debugSessionLogFile, true);
        this.debuggeeServer = new DebuggeeSessionFactory();
    };

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        this.logRequest(response);

        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;

        response.body.supportsEvaluateForHovers = true;
        response.body.supportsStepBack = false;
        response.body.supportsSetVariable = true;
        response.body.supportsFunctionBreakpoints = false;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;
        response.body.supportSuspendDebuggee = true;
        response.body.supportTerminateDebuggee = true;
        response.body.supportsSingleThreadExecutionRequests = true;

        this.sendResponse(response);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments) {
        this.logRequest(response);
        await this.configurationDone.wait(1000);
        if(!this.configureAttach(response, <AttachRequestArguments>args)){
            return;
        }

        this.watingDebuggeeSession();

        if(this.launchInterpreter || this.launchExecutable) {
            this.debugProcess = launchScript(this, this);
            this.debugProcess.runTerminal(() => {
                this.debuggee.forEach(function (debuggee) {
                    debuggee.stop();
                });
                this.debuggee = [];
                
                if (this.debuggeeServer) {
                    this.debuggeeServer.dispose();
                    this.debuggeeServer = undefined;
                }

                this.sendEvent(new TerminatedEvent());
            });
        }

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments) {
        this.logRequest(response);
        await this.configurationDone.wait(1000);

        if(!this.configureLaunch(response, <LaunchRequestArguments>args)){
            return;
        }

        if (!this.noDebug) {
            this.watingDebuggeeSession();
            this.sendResponse(response);
            this.sendEvent(new InitializedEvent());
        }

        this.debugProcess = launchScript(this, this);
        this.debugProcess.run((code?:number) => {
            this.debuggee.forEach(function (debuggee) {
                debuggee.stop();
            });
            this.debuggee = [];

            if (this.debuggeeServer) {
                this.debuggeeServer.dispose();
                this.debuggeeServer = undefined;
            }

            if(code !== undefined){
                this.sendEvent(new ExitedEvent(code));
            }
            this.sendEvent(new TerminatedEvent());
        });

        if (this.noDebug) {
            this.sendResponse(response);
            this.sendEvent(new TerminatedEvent());
        }
    }

    private configureAttach(response: DebugProtocol.Response, args: AttachRequestArguments):boolean{
        if (args.executable) {
            this.launchExecutable = args.noDebug ? (args.executableNoDebug ? args.executableNoDebug : args.executable) : args.executable;
            this.launchInterpreter = '';
        } else if(args.interpreter) {
            this.launchInterpreter = args.interpreter;
            this.launchExecutable = '';
        }

        if(this.launchInterpreter || this.launchExecutable) {
            this.launchArguments = args.arguments || [];
            this.terminalMode = args.runMode === 'shell' ? DebuggeeTerminalMode.native : DebuggeeTerminalMode.task;
        }

        return this.configureCommon(response, args);
    }

    private configureLaunch(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments):boolean{
        if (args.executable) {
            this.launchExecutable = args.executable;
            this.launchInterpreter = '';
        } else {
            this.launchInterpreter = args.interpreter || 'lua';
            this.launchExecutable = '';
        }

        this.launchArguments   = args.arguments || [];
        this.launchEnveronment = args.env;

        // TODO: validate launch configuration
        return this.configureCommon(response, args);
    }

    private configureCommon(response: DebugProtocol.Response, args: RequestArguments): boolean{
        this.debuggeeHost     = args.listenPublicly ? '0.0.0.0' : '127.0.0.1';
        this.debuggeePort     = args.listenPort || 56789;
        this.sourceEncoding   = parseEncoding(args.sourceEncoding) || 'utf8';
        this.consoleEncoding  = parseEncoding(args.consoleEncoding) || <BufferEncoding>args.sourceEncoding;
        this.workingDirectory = args.workingDirectory || '';
        this.sourceBasePath   = args.sourceBasePath   || this.workingDirectory;
        if (args.stopOnEntry === undefined) {
            this.stopOnEntry = false;
        } else {
            this.stopOnEntry = args.stopOnEntry;
        }

        if (args.pathMap) {
            this.pathMap = new Array();
            for (let i in args.pathMap) {
                let localPath = args.pathMap[i]['localPrefix'];
                if (!path_is_absolute(localPath)) {
                    localPath = path_join(this.sourceBasePath, localPath);
                }
                localPath = path_normalize(localPath);
                let remotePath = args.pathMap[i]['remotePrefix'];
                this.pathMap.push(new PathMap(localPath, remotePath));
            }
        }

        // TODO: validate common configuration
        return true;
    }

    private watingDebuggeeSession(){
        assert(this.debuggeeServer !== undefined);
        this.debuggeeServer?.waitSession(this.debuggeeHost, this.debuggeePort, (debuggee: DebuggeeSession) => {
            this.processDebuggeeSession(debuggee);
        });
    }

    private processDebuggeeSession(debuggee: DebuggeeSession) {
        this.debuggee.push(debuggee);
        debuggee.threadId = this.debuggee.length - 1;

        debuggee.on('event', (event: DebugProtocol.Event) => {
            this.sendEvent(event);
        });

        debuggee.on('welcome', (response: DebugProtocol.Response) => {
            if(response.body !== undefined && response.body.threadName !== undefined) {
                debuggee.threadName = response.body.threadName;
            }
        });

        debuggee.on('response', (response: DebugProtocol.Response) => {
            --this.pendingResponseCount;
            if (this.pendingResponseCount <= 0) {
                this.sendResponse(response);
            }
            else {
                this.logRequest(response);
            }
        });

        debuggee.on('close', (message) => {
            this.sendEvent(new ThreadEvent('exited', debuggee.threadId));
            debuggee.threadId = -1;
        });

        debuggee.processSession(this);

        this.sendEvent(new ThreadEvent('started', debuggee.threadId));
    }

    private proxyThread(threadId: number, response: DebugProtocol.Response, args?: any)
    {
        this.logRequestThread(threadId, response);
        let debuggee = this.debuggee.at(threadId);
        if(debuggee) {
            this.pendingResponseCount = 1;
            debuggee.proxy(response, args);
        }
    }

    private proxyAll(response: DebugProtocol.Response, args?: any): void {
        this.logRequest(response);

        let owner = this;
        owner.pendingResponseCount = 0;
        this.debuggee.forEach(function (debuggee) {
            if (debuggee.threadId !== -1) {
                owner.pendingResponseCount++;
                debuggee.proxy(response, args);
            }
        });
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        if (args !== undefined && args.threadId !== undefined) {
            this.currentThread = args.threadId;
            this.proxyThread(this.currentThread, response, args);
        }
        else {
            this.proxyAll(response, args);
        }
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        if (args !== undefined && args.threadId !== undefined) {
            this.currentThread = args.threadId;
            this.proxyThread(this.currentThread, response, args);
        }
        //this.proxyAll(response, args);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        if (args !== undefined && args.threadId !== undefined) {
            this.currentThread = args.threadId;
            this.proxyThread(this.currentThread, response, args);
        }
        else {
            this.proxyAll(response, args);
        }
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        if (args !== undefined && args.threadId !== undefined) {
            this.currentThread = args.threadId;
            this.proxyThread(this.currentThread, response, args);
        }
        else {
            this.proxyAll(response, args);
        }
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
        if (args !== undefined && args.threadId !== undefined) {
            this.currentThread = args.threadId;
            this.proxyThread(this.currentThread, response, args);
        }
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        if (this.currentThread !== undefined) {
            this.proxyThread(this.currentThread, response, args);
        }
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        if (this.currentThread !== undefined) {
            this.proxyThread(this.currentThread, response, args);
        }
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = { threads: [] };
        this.debuggee.forEach(function (debuggee) {
            if (debuggee.threadId !== -1) {
                response.body.threads.push(new Thread(debuggee.threadId, debuggee.threadName));
            }
        });
        this.sendResponse(response);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
        assert(args.source.path !== undefined);
        
        if (args === undefined || args.breakpoints === undefined || args.breakpoints.length === 0) {
            delete this.breakPoints[args.source.path!.toLowerCase()];
        }
        else {
            this.breakPoints[args.source.path!.toLowerCase()] = JSON.stringify(args);
        }

        this.proxyAll(response, args);
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        this.configurationDone.notify();
        this.sendResponse(response);
    }

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        if (this.currentThread !== undefined) {
            this.proxyThread(this.currentThread, response, args);
        }
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this.proxyAll(response, args);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
        this.logRequest(response);

        if(!args.restart) {
            if (this.debuggeeServer) {
                this.debuggeeServer.dispose();
                this.debuggeeServer = undefined;
            }
        }

        if (args.terminateDebuggee) {
            if (this.debugProcess) {
                this.debugProcess.dispose(true);
                this.debugProcess = undefined;
            }

            this.debuggee.forEach(function (debuggee) {
                debuggee.stop();
            });
            this.debuggee = [];

            this.sendResponse(response);
        } else if (this.debuggee.length !== 0) {
            let timer = setTimeout(() => {
                if (this.debugProcess) {
                    this.debugProcess.dispose(false);
                    this.debugProcess = undefined;
                }
                this.debuggee.forEach(function (debuggee) {
                    debuggee.stop();
                });
                this.debuggee = [];
                this.sendResponse(response);
            }, 15000);

            let owner = this;
            this.debuggee.forEach(function (debuggee) {
                debuggee.disconnect(response, args, (response, self) => {
                    clearTimeout(timer);
                    if (self.debugProcess) {
                        self.debugProcess.dispose(false);
                        self.debugProcess = undefined;
                    }
                    if (self.debuggee) {
                        self.debuggee.stop();
                        self.debuggee = undefined;
                    }
                    owner.sendResponse(response);
                }, owner);
            });
        } else if (this.debugProcess) {
            this.debugProcess.dispose(false);
            this.debugProcess = undefined;
        }
    }
 
    public sendResponse(response: DebugProtocol.Response): void{
        this.logResponse(response);
        super.sendResponse(response);
    }

    public sendEvent(event: DebugProtocol.Event): void{
        this.logEvent(event);
        super.sendEvent(event);
    }

    public printDebugConsole(message: string){
        let event = new OutputEvent(message + '\n', 'console');
        this.sendEvent(event);
    }

    public printDebugStdout(message: string){
        let event = new OutputEvent(message, 'stdout');
        this.sendEvent(event);
    }

    public printDebugStderr(message: string){
        let event = new OutputEvent(message, 'stderr');
        this.sendEvent(event);
    }

    private debugAdapterLog(message: string){
        let status = (this.debuggee.length !== 0) ? '+' : '-';
        DebugLogger.logAdapterInfo("[DebuggerSession][" + status + "] " + message);
        console.log(message);
    }

    private logRequest(response: DebugProtocol.Response){
        let msg = `Request: ${response.command}[${response.request_seq}]`;
        this.debugAdapterLog(msg);
    }

    private logRequestThread(threadId: number, response: DebugProtocol.Response){
        let msg = `Request to ${threadId}: ${response.command}[${response.request_seq}]`;
        this.debugAdapterLog(msg);
    }

    private logResponse(response: DebugProtocol.Response){
        let status = response.success ? 'success' : 'fail';
        let msg = `Response: ${response.command}[${response.request_seq}] - ${status}`;
        this.debugAdapterLog(msg);
    }

    private logEvent(event: DebugProtocol.Event){
        let msg = `Event: ${event.event}[${event.seq}]`;
        this.debugAdapterLog(msg);
    }
}

interface RequestArguments {
    workingDirectory: string;
    sourceBasePath?: string;
    listenPublicly?: boolean;
    listenPort?: number;
    sourceEncoding?: string;
    consoleEncoding?: string;
    stopOnEntry?: boolean;
    pathMap?:Array<Object>;
}

interface LaunchRequestArguments extends RequestArguments {
    noDebug?: boolean;
    executable?: string;
    interpreter?: string;
    arguments?: Array<string>;
    env?: { [key: string]: string | null | undefined },
}

interface AttachRequestArguments extends RequestArguments {
    noDebug?: boolean;
    executable?: string;
    executableNoDebug?: string;
    interpreter?: string;
    arguments?: Array<string>;
    runMode?: string;
}

const ENCODINGS = new Set(["ascii", "utf8", "utf-8", "utf16le", "ucs2", "ucs-2", "base64", "base64url", "latin1"]);

function parseEncoding(encoding:string | undefined):BufferEncoding | undefined{
    if (encoding === undefined) {
        return undefined;
    }

    encoding = encoding.toLowerCase();
    if (ENCODINGS.has(encoding)) {
        return <BufferEncoding>encoding;
    }

    return undefined;
}
