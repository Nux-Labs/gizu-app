import type {FastifyInstance,FastifyReply,FastifyRequest,FastifyError} from 'fastify';
import {CoordinationError} from '../../adapters/earn/operation-coordinator.ts';
import {FusionNativeGateway} from '../../adapters/earn/fusion-native.ts';
export function registerEarnFusionRoutes(app:FastifyInstance,gateway:FusionNativeGateway){
 const fail=(reply:FastifyReply,status=502)=>reply.code(status).send({code:'EARN_FUSION_UNAVAILABLE',message:'The native Fusion request could not be verified.'});
 const options={bodyLimit:262144,logLevel:'silent' as const,errorHandler(error:FastifyError,_request:FastifyRequest,reply:FastifyReply){return fail(reply,error.statusCode===413?413:400);}};
 let active=0;const buckets=new Map<string,{start:number;count:number}>();
 for(const[route,method]of [['quote','quote'],['quote-binding','binding'],['submit','submit'],['status','status']]as const){app.post(`/v1/earn/native/fusion/${route}`,options,async(request,reply)=>{reply.header('Cache-Control','no-store');const now=Date.now();for(const[ip,b]of buckets)if(now-b.start>60000)buckets.delete(ip);const b=buckets.get(request.ip)??{start:now,count:0};if(active>=8||b.count>=30||buckets.size>=2048)return fail(reply,429);b.count++;buckets.set(request.ip,b);active++;try{return reply.send(await gateway[method](request.body));}catch(error){return fail(reply,error instanceof CoordinationError?error.statusCode:502);}finally{active--;}});}
}
