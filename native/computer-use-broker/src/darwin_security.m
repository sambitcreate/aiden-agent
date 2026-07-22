#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Security/Security.h>
#import <bsm/libbsm.h>
#import <errno.h>
#import <mach/mach.h>
#import <mach/task_info.h>
#import <stdbool.h>
#import <stdint.h>
#import <stdio.h>
#import <string.h>

// DER produced by LightweightCodeRequirements.LaunchCodeRequirement for:
//   cdhash in { arm64 7d385f..., x86_64 92c53b... }
//   signing-identifier = cua-driver; team-identifier = YCK386LBJ7
//   Developer ID; macOS; dynamically valid, signed, hardened, CS_KILL
// The Rust tests pin the complete bytes and all source facts. NSTask passes
// this spawn constraint to the kernel, which rejects a raced executable before
// its first user-space instruction.
static const uint8_t kCuaDriverLaunchRequirement[] = {
    0x70, 0x82, 0x01, 0x0c, 0x02, 0x01, 0x01, 0xb0, 0x82, 0x01, 0x05, 0x30,
    0x09, 0x0c, 0x04, 0x63, 0x63, 0x61, 0x74, 0x02, 0x01, 0x00, 0x30, 0x09,
    0x0c, 0x04, 0x63, 0x6f, 0x6d, 0x70, 0x02, 0x01, 0x01, 0x30, 0x81, 0xe1,
    0x0c, 0x04, 0x72, 0x65, 0x71, 0x73, 0xb0, 0x81, 0xd8, 0x30, 0x3f, 0x0c,
    0x06, 0x63, 0x64, 0x68, 0x61, 0x73, 0x68, 0xb0, 0x35, 0x30, 0x33, 0x0c,
    0x03, 0x24, 0x69, 0x6e, 0x30, 0x2c, 0x04, 0x14, 0x7d, 0x38, 0x5f, 0xc0,
    0x89, 0x96, 0xbc, 0x36, 0x98, 0xef, 0x62, 0x95, 0xaa, 0x97, 0x0d, 0x31,
    0x2b, 0xc6, 0x10, 0xc5, 0x04, 0x14, 0x92, 0xc5, 0x3b, 0x31, 0x0c, 0xee,
    0x9d, 0x8d, 0x71, 0xc9, 0x7e, 0x76, 0x0e, 0x29, 0x20, 0xc9, 0xc4, 0x68,
    0x08, 0x6d, 0x30, 0x2b, 0x0c, 0x12, 0x63, 0x6f, 0x64, 0x65, 0x2d, 0x73,
    0x69, 0x67, 0x6e, 0x69, 0x6e, 0x67, 0x2d, 0x66, 0x6c, 0x61, 0x67, 0x73,
    0xb0, 0x15, 0x30, 0x13, 0x0c, 0x0b, 0x24, 0x66, 0x6c, 0x61, 0x67, 0x2d,
    0x63, 0x68, 0x65, 0x63, 0x6b, 0x02, 0x04, 0x20, 0x01, 0x02, 0x01, 0x30,
    0x0d, 0x0c, 0x08, 0x70, 0x6c, 0x61, 0x74, 0x66, 0x6f, 0x72, 0x6d, 0x02,
    0x01, 0x01, 0x30, 0x20, 0x0c, 0x12, 0x73, 0x69, 0x67, 0x6e, 0x69, 0x6e,
    0x67, 0x2d, 0x69, 0x64, 0x65, 0x6e, 0x74, 0x69, 0x66, 0x69, 0x65, 0x72,
    0x0c, 0x0a, 0x63, 0x75, 0x61, 0x2d, 0x64, 0x72, 0x69, 0x76, 0x65, 0x72,
    0x30, 0x1d, 0x0c, 0x0f, 0x74, 0x65, 0x61, 0x6d, 0x2d, 0x69, 0x64, 0x65,
    0x6e, 0x74, 0x69, 0x66, 0x69, 0x65, 0x72, 0x0c, 0x0a, 0x59, 0x43, 0x4b,
    0x33, 0x38, 0x36, 0x4c, 0x42, 0x4a, 0x37, 0x30, 0x18, 0x0c, 0x13, 0x76,
    0x61, 0x6c, 0x69, 0x64, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x2d, 0x63, 0x61,
    0x74, 0x65, 0x67, 0x6f, 0x72, 0x79, 0x02, 0x01, 0x06, 0x30, 0x09, 0x0c,
    0x04, 0x76, 0x65, 0x72, 0x73, 0x02, 0x01, 0x01,
};

static void copy_error(char *buffer, size_t capacity, NSString *message) {
    if (buffer == NULL || capacity == 0) {
        return;
    }
    const char *value = message.UTF8String ?: "unknown Darwin security error";
    strlcpy(buffer, value, capacity);
}

static NSString *requirement_string(const char *identifier, const char *team) {
    if (identifier == NULL || team == NULL) {
        return nil;
    }
    NSString *identifierString = [NSString stringWithUTF8String:identifier];
    NSString *teamString = [NSString stringWithUTF8String:team];
    if (identifierString == nil || teamString == nil) {
        return nil;
    }
    return [NSString stringWithFormat:
        @"anchor apple generic and identifier \"%@\" and certificate leaf[subject.OU] = \"%@\"",
        identifierString,
        teamString];
}

void aiden_request_computer_use_permissions(void) {
    @autoreleasepool {
        // In embedded mode cua-driver deliberately never raises TCC prompts.
        // This LaunchServices-owned helper is the responsible host, so it must
        // request both grants itself after Aiden's authenticated settings flow
        // reaches the broker. These calls are no-ops for grants already held.
        NSDictionary *accessibilityOptions = @{
            (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES
        };
        (void)AXIsProcessTrustedWithOptions(
            (__bridge CFDictionaryRef)accessibilityOptions);
        (void)CGRequestScreenCaptureAccess();
    }
}

static int copy_signing_information(
    CFTypeRef code,
    char *cdhash,
    size_t cdhashCapacity,
    char *executable,
    size_t executableCapacity,
    char *error,
    size_t errorCapacity
) {
    CFDictionaryRef rawInformation = NULL;
    OSStatus status = SecCodeCopySigningInformation(
        (SecCodeRef)code,
        kSecCSSigningInformation | kSecCSDynamicInformation,
        &rawInformation);
    if (status != errSecSuccess || rawInformation == NULL) {
        copy_error(error, errorCapacity,
                   [NSString stringWithFormat:@"could not read code identity (%d)", (int)status]);
        return status == errSecSuccess ? EINVAL : (int)status;
    }
    NSDictionary *information = CFBridgingRelease(rawInformation);
    NSData *unique = information[(__bridge NSString *)kSecCodeInfoUnique];
    if (![unique isKindOfClass:[NSData class]] || unique.length != 20 || cdhashCapacity < 41) {
        copy_error(error, errorCapacity, @"code identity omitted its 20-byte CDHash");
        return EINVAL;
    }
    const uint8_t *bytes = unique.bytes;
    for (NSUInteger index = 0; index < unique.length; index++) {
        snprintf(cdhash + (index * 2), cdhashCapacity - (index * 2), "%02x", bytes[index]);
    }
    cdhash[40] = '\0';

    if (executable != NULL && executableCapacity > 0) {
        id value = information[(__bridge NSString *)kSecCodeInfoMainExecutable];
        NSString *path = [value isKindOfClass:[NSURL class]] ? ((NSURL *)value).path : nil;
        if (path == nil) {
            copy_error(error, errorCapacity, @"code identity omitted its executable path");
            return EINVAL;
        }
        strlcpy(executable, path.fileSystemRepresentation, executableCapacity);
        if (strlen(path.fileSystemRepresentation) >= executableCapacity) {
            copy_error(error, errorCapacity, @"code executable path exceeded its bound");
            return ENAMETOOLONG;
        }
    }
    return 0;
}

static int copy_live_code_identity_with_attributes(
    NSDictionary *attributes,
    const char *identifier,
    const char *team,
    char *cdhash,
    size_t cdhashCapacity,
    char *executable,
    size_t executableCapacity,
    char *error,
    size_t errorCapacity
) {
    @autoreleasepool {
        NSString *requirementValue = requirement_string(identifier, team);
        if (attributes == nil || requirementValue == nil) {
            copy_error(error, errorCapacity, @"invalid code requirement input");
            return EINVAL;
        }
        SecRequirementRef requirement = NULL;
        OSStatus status = SecRequirementCreateWithString(
            (__bridge CFStringRef)requirementValue, kSecCSDefaultFlags, &requirement);
        if (status != errSecSuccess || requirement == NULL) {
            copy_error(error, errorCapacity,
                       [NSString stringWithFormat:@"could not create code requirement (%d)", (int)status]);
            return status == errSecSuccess ? EINVAL : (int)status;
        }
        SecCodeRef code = NULL;
        status = SecCodeCopyGuestWithAttributes(
            NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &code);
        if (status == errSecSuccess && code != NULL) {
            status = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
        }
        CFRelease(requirement);
        if (status != errSecSuccess || code == NULL) {
            if (code != NULL) {
                CFRelease(code);
            }
            copy_error(error, errorCapacity,
                       [NSString stringWithFormat:@"live code failed its requirement (%d)", (int)status]);
            return status == errSecSuccess ? EINVAL : (int)status;
        }
        int result = copy_signing_information(
            code, cdhash, cdhashCapacity, executable, executableCapacity, error, errorCapacity);
        CFRelease(code);
        return result;
    }
}

int aiden_copy_live_code_identity(
    int pid,
    const char *identifier,
    const char *team,
    char *cdhash,
    size_t cdhashCapacity,
    char *executable,
    size_t executableCapacity,
    char *error,
    size_t errorCapacity
) {
    @autoreleasepool {
        if (pid <= 1) {
            copy_error(error, errorCapacity, @"invalid live process id");
            return EINVAL;
        }
        NSDictionary *attributes = @{ (__bridge NSString *)kSecGuestAttributePid: @(pid) };
        return copy_live_code_identity_with_attributes(
            attributes,
            identifier,
            team,
            cdhash,
            cdhashCapacity,
            executable,
            executableCapacity,
            error,
            errorCapacity);
    }
}

int aiden_copy_live_code_identity_for_audit_token(
    const audit_token_t *auditToken,
    const char *identifier,
    const char *team,
    char *cdhash,
    size_t cdhashCapacity,
    char *executable,
    size_t executableCapacity,
    char *error,
    size_t errorCapacity
) {
    @autoreleasepool {
        if (auditToken == NULL || audit_token_to_pid(*auditToken) <= 1) {
            copy_error(error, errorCapacity, @"invalid live process audit token");
            return EINVAL;
        }
        NSData *auditData = [NSData dataWithBytes:auditToken length:sizeof(*auditToken)];
        NSDictionary *attributes = @{ (__bridge NSString *)kSecGuestAttributeAudit: auditData };
        return copy_live_code_identity_with_attributes(
            attributes,
            identifier,
            team,
            cdhash,
            cdhashCapacity,
            executable,
            executableCapacity,
            error,
            errorCapacity);
    }
}

int aiden_audit_token_pid(const audit_token_t *auditToken) {
    return auditToken == NULL ? -1 : audit_token_to_pid(*auditToken);
}

int aiden_copy_process_audit_token(
    int pid,
    audit_token_t *auditTokenOutput,
    char *error,
    size_t errorCapacity
) {
    if (pid <= 1 || auditTokenOutput == NULL) {
        copy_error(error, errorCapacity, @"invalid process audit-token input");
        return EINVAL;
    }
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t status = task_name_for_pid(mach_task_self(), pid, &task);
    if (status != KERN_SUCCESS || task == MACH_PORT_NULL) {
        copy_error(error, errorCapacity,
                   [NSString stringWithFormat:@"could not acquire process identity (%d)", status]);
        return status == KERN_SUCCESS ? EPERM : (int)status;
    }
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    status = task_info(
        task,
        TASK_AUDIT_TOKEN,
        (task_info_t)auditTokenOutput,
        &count);
    mach_port_deallocate(mach_task_self(), task);
    if (status != KERN_SUCCESS || count != TASK_AUDIT_TOKEN_COUNT) {
        copy_error(error, errorCapacity,
                   [NSString stringWithFormat:@"could not read process identity (%d)", status]);
        return status == KERN_SUCCESS ? EINVAL : (int)status;
    }
    if (audit_token_to_pid(*auditTokenOutput) != pid) {
        copy_error(error, errorCapacity, @"process identity changed during capture");
        return ESRCH;
    }
    return 0;
}

int aiden_copy_static_code_identity(
    const char *path,
    const char *identifier,
    const char *team,
    bool checkAllArchitectures,
    char *cdhash,
    size_t cdhashCapacity,
    char *error,
    size_t errorCapacity
) {
    @autoreleasepool {
        if (path == NULL) {
            copy_error(error, errorCapacity, @"invalid static code path");
            return EINVAL;
        }
        NSString *pathValue = [NSString stringWithUTF8String:path];
        NSString *requirementValue = requirement_string(identifier, team);
        if (pathValue == nil || requirementValue == nil) {
            copy_error(error, errorCapacity, @"invalid static code input");
            return EINVAL;
        }
        SecStaticCodeRef code = NULL;
        OSStatus status = SecStaticCodeCreateWithPath(
            (__bridge CFURLRef)[NSURL fileURLWithPath:pathValue], kSecCSDefaultFlags, &code);
        SecRequirementRef requirement = NULL;
        if (status == errSecSuccess && code != NULL) {
            status = SecRequirementCreateWithString(
                (__bridge CFStringRef)requirementValue, kSecCSDefaultFlags, &requirement);
        }
        if (status == errSecSuccess && requirement != NULL) {
            SecCSFlags flags = kSecCSStrictValidate;
            if (checkAllArchitectures) {
                flags |= kSecCSCheckAllArchitectures;
            }
            status = SecStaticCodeCheckValidity(code, flags, requirement);
        }
        if (requirement != NULL) {
            CFRelease(requirement);
        }
        if (status != errSecSuccess || code == NULL) {
            if (code != NULL) {
                CFRelease(code);
            }
            copy_error(error, errorCapacity,
                       [NSString stringWithFormat:@"static code failed its requirement (%d)", (int)status]);
            return status == errSecSuccess ? EINVAL : (int)status;
        }
        int result = copy_signing_information(
            code, cdhash, cdhashCapacity, NULL, 0, error, errorCapacity);
        CFRelease(code);
        return result;
    }
}

int aiden_copy_bundle_info_string(
    const char *bundlePath,
    const char *key,
    char *output,
    size_t outputCapacity,
    char *error,
    size_t errorCapacity
) {
    @autoreleasepool {
        NSString *pathValue = bundlePath == NULL ? nil : [NSString stringWithUTF8String:bundlePath];
        NSString *keyValue = key == NULL ? nil : [NSString stringWithUTF8String:key];
        if (pathValue == nil || keyValue == nil || output == NULL || outputCapacity == 0) {
            copy_error(error, errorCapacity, @"invalid bundle metadata input");
            return EINVAL;
        }
        NSURL *infoURL = [[NSURL fileURLWithPath:pathValue isDirectory:YES]
            URLByAppendingPathComponent:@"Contents/Info.plist" isDirectory:NO];
        NSDictionary *information = [NSDictionary dictionaryWithContentsOfURL:infoURL];
        NSString *value = [information[keyValue] isKindOfClass:[NSString class]]
            ? information[keyValue]
            : nil;
        if (value == nil) {
            copy_error(error, errorCapacity, @"signed helper metadata omitted a required value");
            return EINVAL;
        }
        strlcpy(output, value.UTF8String, outputCapacity);
        if (strlen(value.UTF8String) >= outputCapacity) {
            copy_error(error, errorCapacity, @"signed helper metadata exceeded its bound");
            return ENAMETOOLONG;
        }
        return 0;
    }
}

int aiden_spawn_constrained_driver(
    const char *path,
    const char *const *arguments,
    const char *const *environment,
    int stdinFd,
    int stdoutFd,
    int stderrFd,
    int *pidOutput,
    void **taskOutput,
    char *error,
    size_t errorCapacity
) {
    @autoreleasepool {
        if (path == NULL || arguments == NULL || environment == NULL || pidOutput == NULL || taskOutput == NULL) {
            copy_error(error, errorCapacity, @"invalid constrained launch input");
            return EINVAL;
        }
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];

        NSMutableArray<NSString *> *taskArguments = [NSMutableArray array];
        for (size_t index = 0; arguments[index] != NULL; index++) {
            NSString *value = [NSString stringWithUTF8String:arguments[index]];
            if (value == nil) {
                copy_error(error, errorCapacity, @"driver argument was not UTF-8");
                return EINVAL;
            }
            [taskArguments addObject:value];
        }
        task.arguments = taskArguments;

        NSMutableDictionary<NSString *, NSString *> *taskEnvironment = [NSMutableDictionary dictionary];
        for (size_t index = 0; environment[index] != NULL; index++) {
            NSString *entry = [NSString stringWithUTF8String:environment[index]];
            NSRange delimiter = [entry rangeOfString:@"="];
            if (entry == nil || delimiter.location == NSNotFound || delimiter.location == 0) {
                copy_error(error, errorCapacity, @"driver environment entry was invalid");
                return EINVAL;
            }
            taskEnvironment[[entry substringToIndex:delimiter.location]] =
                [entry substringFromIndex:delimiter.location + 1];
        }
        task.environment = taskEnvironment;
        task.standardInput = [[NSFileHandle alloc] initWithFileDescriptor:stdinFd closeOnDealloc:NO];
        task.standardOutput = [[NSFileHandle alloc] initWithFileDescriptor:stdoutFd closeOnDealloc:NO];
        task.standardError = [[NSFileHandle alloc] initWithFileDescriptor:stderrFd closeOnDealloc:NO];
        task.launchRequirementData = [NSData dataWithBytes:kCuaDriverLaunchRequirement
                                                   length:sizeof(kCuaDriverLaunchRequirement)];

        NSError *launchError = nil;
        if (![task launchAndReturnError:&launchError]) {
            copy_error(error, errorCapacity,
                       launchError.localizedDescription ?: @"kernel rejected constrained driver launch");
            return launchError.code == 0 ? EPERM : (int)launchError.code;
        }
        *pidOutput = task.processIdentifier;
        *taskOutput = (__bridge_retained void *)task;
        return 0;
    }
}

int aiden_task_wait(void *taskHandle, int *statusOutput, int *reasonOutput) {
    if (taskHandle == NULL || statusOutput == NULL || reasonOutput == NULL) {
        return EINVAL;
    }
    NSTask *task = (__bridge NSTask *)taskHandle;
    [task waitUntilExit];
    *statusOutput = task.terminationStatus;
    *reasonOutput = (int)task.terminationReason;
    return 0;
}

bool aiden_task_is_running(void *taskHandle) {
    if (taskHandle == NULL) {
        return false;
    }
    NSTask *task = (__bridge NSTask *)taskHandle;
    return task.running;
}

void aiden_task_terminate(void *taskHandle) {
    if (taskHandle != NULL) {
        NSTask *task = (__bridge NSTask *)taskHandle;
        if (task.running) {
            [task terminate];
        }
    }
}

void aiden_task_release(void *taskHandle) {
    if (taskHandle != NULL) {
        CFRelease(taskHandle);
    }
}

const uint8_t *aiden_cua_launch_requirement_bytes(size_t *length) {
    if (length != NULL) {
        *length = sizeof(kCuaDriverLaunchRequirement);
    }
    return kCuaDriverLaunchRequirement;
}
