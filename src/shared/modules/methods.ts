// The methods a module declares: what its main half serves, and what its
// renderer half (or any client the person granted it) calls, over the Studio
// protocol's `module.read` and `module.operate`
// (packages/studio-protocol/src/modules.ts).
//
// A module writes a contract per method, a type: who may call it (`access`),
// what it takes, what it answers, and the refusals of its own it may answer
// with. Its main half registers each with a validator for its params and a
// handler (`MainHost.registerMethods`); its renderer half calls them through
// `RendererHost.methods<Contract>()`, which only offers a `read` method to
// `read` and an `operate` one to `operate`. The types and the name rule are
// declared once, in the published SDK, and re-exported here for app code, as
// the host API version is (host-api.ts).

export {
  MODULE_METHOD_MAX_CHARS,
  isModuleMethodName,
  type ModuleCallAnswer,
  type ModuleCallRefusalCode,
  type ModuleMethodAccess,
  type ModuleMethodAnswer,
  type ModuleMethodContext,
  type ModuleMethodContract,
  type ModuleMethodContracts,
  type ModuleMethodErrorCode,
  type ModuleMethodParsed,
  type ModuleMethodRegistration,
  type ModuleMethodRegistrations,
  type ModuleMethodsClient,
  type ModuleOperateMethod,
  type ModuleReadMethod,
} from '../../../packages/module-sdk/src/methods'
